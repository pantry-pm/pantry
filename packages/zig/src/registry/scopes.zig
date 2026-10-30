//! Scope pinning: a package scope that resolves from one Pantry registry and
//! nowhere else.
//!
//!     // pantry.json
//!     {
//!       "scopes": { "@hq": "pantry" },
//!       "dependencies": { "@hq/platform": "^1.4.0" }
//!     }
//!
//! A pinned name is private by declaration. Resolving it anywhere but its
//! registry is dependency confusion: the moment the private lookup fails - no
//! token, an expired token, a typo, the registry down - an unpinned install
//! falls through to npm and installs whatever a stranger published under the
//! same name. So for a pinned scope:
//!
//!   * the version comes from `GET {registry}/packages/{name}/versions`, for an
//!     exact pin and a range alike, chosen by semver;
//!   * the metadata and tarball come from that registry too, authenticated with
//!     the credential `endpoint.zig` holds for it;
//!   * every failure - 401, 402, 403, 404, unreachable, malformed - is an
//!     install error that says what to do. Nothing else is ever consulted.
//!
//! The value is `"pantry"` (the Pantry registry this machine talks to:
//! `PANTRY_REGISTRY_URL`, else registry.pantry.dev) or the URL of another
//! registry that speaks the Pantry protocol.
//!
//! Unpinned names keep their existing order, with one rule from here too: a
//! Pantry registry that answers 401/402/403 for a name has told us the name is
//! *its* and needs a credential or a purchase. That is never a reason to try
//! npm (`allowsNpmFallback`).

const std = @import("std");
const io_helper = @import("../io_helper.zig");
const endpoint = @import("endpoint.zig");
const semver = @import("../packages/semver.zig");
const parser = @import("../deps/parser.zig");
const auth_registry = @import("../auth/registry.zig");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// One `"@scope": "pantry" | "https://…"` entry.
pub const Pin = struct {
    /// `@hq` - always starts with '@', never ends with '/'.
    scope: []const u8,
    /// `"pantry"` or an http(s) base URL with no trailing slash.
    registry: []const u8,

    /// The base URL requests for this scope go to.
    pub fn baseUrl(self: Pin) []const u8 {
        if (isPantryAlias(self.registry)) return endpoint.baseUrl();
        return self.registry;
    }
};

fn isPantryAlias(value: []const u8) bool {
    return std.ascii.eqlIgnoreCase(value, "pantry");
}

pub const Config = struct {
    arena: std.heap.ArenaAllocator,
    pins: []const Pin = &.{},

    pub fn init(backing: std.mem.Allocator) Config {
        return .{ .arena = std.heap.ArenaAllocator.init(backing) };
    }

    pub fn deinit(self: *Config) void {
        self.arena.deinit();
    }

    pub fn isEmpty(self: *const Config) bool {
        return self.pins.len == 0;
    }

    /// The pin covering `name`, if its scope is pinned. Scope comparison is
    /// case-insensitive: npm folds scopes to lower case, so `@HQ/x` and `@hq/x`
    /// are the same private package and must not slip past the pin.
    pub fn pinFor(self: *const Config, name: []const u8) ?Pin {
        const scope = scopeOf(name) orelse return null;
        for (self.pins) |pin| {
            if (std.ascii.eqlIgnoreCase(pin.scope, scope)) return pin;
        }
        return null;
    }

    /// Add a pin unless the scope is already pinned (first declaration wins,
    /// so pantry.json outranks package.json).
    fn add(self: *Config, scope: []const u8, registry: []const u8) !void {
        for (self.pins) |pin| {
            if (std.ascii.eqlIgnoreCase(pin.scope, scope)) return;
        }
        const a = self.arena.allocator();
        const next = try a.alloc(Pin, self.pins.len + 1);
        @memcpy(next[0..self.pins.len], self.pins);
        next[self.pins.len] = .{ .scope = try a.dupe(u8, scope), .registry = try a.dupe(u8, registry) };
        self.pins = next;
    }
};

/// Why a `scopes` block was rejected. A malformed pin is an error rather than
/// something to skip: skipping it silently turns a private scope back into one
/// that resolves from npm, which is the exact failure pinning exists to stop.
pub const Diagnostic = struct {
    buf: [256]u8 = undefined,
    len: usize = 0,

    pub fn message(self: *const Diagnostic) []const u8 {
        return self.buf[0..self.len];
    }

    fn set(self: *Diagnostic, comptime fmt: []const u8, args: anytype) void {
        const written = std.fmt.bufPrint(&self.buf, fmt, args) catch {
            self.len = 0;
            return;
        };
        self.len = written.len;
    }
};

/// `@hq/platform` → `@hq`. Unscoped names have no scope.
pub fn scopeOf(name: []const u8) ?[]const u8 {
    if (name.len < 2 or name[0] != '@') return null;
    const slash = std.mem.indexOfScalar(u8, name, '/') orelse return null;
    if (slash < 2) return null;
    return name[0..slash];
}

/// Add every entry of a `"scopes"` JSON object to `cfg`.
pub fn parseInto(cfg: *Config, value: std.json.Value, diag: *Diagnostic) !void {
    if (value != .object) {
        diag.set("\"scopes\" must be an object like {{ \"@hq\": \"pantry\" }}", .{});
        return error.InvalidScopesConfig;
    }
    var it = value.object.iterator();
    while (it.next()) |entry| {
        var scope = std.mem.trim(u8, entry.key_ptr.*, &std.ascii.whitespace);
        if (std.mem.endsWith(u8, scope, "/")) scope = scope[0 .. scope.len - 1];
        if (scope.len < 2 or scope[0] != '@' or std.mem.indexOfScalar(u8, scope, '/') != null) {
            diag.set("\"scopes\" key \"{s}\" is not a scope (expected e.g. \"@hq\")", .{entry.key_ptr.*});
            return error.InvalidScopesConfig;
        }
        if (entry.value_ptr.* != .string) {
            diag.set("\"scopes\".\"{s}\" must be \"pantry\" or a registry URL", .{scope});
            return error.InvalidScopesConfig;
        }
        const raw = std.mem.trim(u8, entry.value_ptr.string, &std.ascii.whitespace);
        const registry = if (isPantryAlias(raw))
            "pantry"
        else blk: {
            const trimmed = std.mem.trimEnd(u8, raw, "/");
            const is_https = std.ascii.startsWithIgnoreCase(trimmed, "https://");
            const is_http = std.ascii.startsWithIgnoreCase(trimmed, "http://");
            if ((!is_https and !is_http) or endpoint.originOf(trimmed) == null or trimmed.len <= "https://".len) {
                diag.set("\"scopes\".\"{s}\" is \"{s}\": use \"pantry\" or an http(s):// registry URL", .{ scope, raw });
                return error.InvalidScopesConfig;
            }
            break :blk trimmed;
        };
        try cfg.add(scope, registry);
    }
}

/// Which keys of a manifest carry scopes. Pantry's own manifests may use a
/// top-level `scopes`; package.json is shared with npm and Bun, so it only
/// reads the `pantry` namespace, the way `pantry.dependencies` already works.
pub const ManifestKind = enum { pantry, package_json };

/// Read the pins declared in one manifest's text (JSON or JSONC).
pub fn parseManifest(cfg: *Config, allocator: std.mem.Allocator, text: []const u8, kind: ManifestKind, diag: *Diagnostic) !void {
    // Cheap pre-check: most manifests pin nothing.
    if (std.mem.indexOf(u8, text, "\"scopes\"") == null) return;

    const stripped = try parser.stripJsonComments(allocator, text);
    defer allocator.free(stripped);
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, stripped, .{}) catch return;
    defer parsed.deinit();
    if (parsed.value != .object) return;

    if (kind == .pantry) {
        if (parsed.value.object.get("scopes")) |scopes| try parseInto(cfg, scopes, diag);
    }
    if (parsed.value.object.get("pantry")) |ns| {
        if (ns == .object) {
            if (ns.object.get("scopes")) |scopes| try parseInto(cfg, scopes, diag);
        }
    }
}

/// The pins in force for a project: `pantry.json`, `pantry.jsonc`, then
/// package.json's `pantry.scopes`, merged with the first declaration of a
/// scope winning.
pub fn loadForProject(allocator: std.mem.Allocator, dir: []const u8, diag: *Diagnostic) !Config {
    var cfg = Config.init(allocator);
    errdefer cfg.deinit();

    const files = [_]struct { name: []const u8, kind: ManifestKind }{
        .{ .name = "pantry.json", .kind = .pantry },
        .{ .name = "pantry.jsonc", .kind = .pantry },
        .{ .name = "package.json", .kind = .package_json },
    };
    for (files) |file| {
        const path = try std.fs.path.join(allocator, &.{ dir, file.name });
        defer allocator.free(path);
        const text = io_helper.readFileAlloc(allocator, path, 10 * 1024 * 1024) catch continue;
        defer allocator.free(text);
        parseManifest(&cfg, allocator, text, file.kind, diag) catch |err| {
            if (err == error.InvalidScopesConfig and diag.len > 0) {
                var prefixed: Diagnostic = .{};
                prefixed.set("{s}: {s}", .{ file.name, diag.message() });
                diag.* = prefixed;
            }
            return err;
        };
    }

    // Requests to a pinned custom registry carry its credential (see
    // `endpoint.trustPinnedRegistry`); the default registry already does.
    for (cfg.pins) |pin| {
        if (!isPantryAlias(pin.registry)) endpoint.trustPinnedRegistry(pin.registry);
    }
    return cfg;
}

// ---------------------------------------------------------------------------
// Decisions (pure)
// ---------------------------------------------------------------------------

/// How a registry lookup ended, as far as the caller's next step goes.
pub const Failure = enum {
    unauthorized, // 401
    payment_required, // 402
    forbidden, // 403
    not_found, // 404, empty version list, or an npm answer from a proxy
    no_matching_version, // the registry has the package, not a version in range
    invalid_range, // a constraint this resolver cannot evaluate
    unavailable, // network error, timeout, 5xx
    invalid_response, // a 200 that is not Pantry package metadata
    integrity_conflict, // the registry's checksum disagrees with pantry.lock
};

/// Map an HTTP status to a failure; null for success.
pub fn classifyStatus(status: u16) ?Failure {
    if (status >= 200 and status < 300) return null;
    return switch (status) {
        401 => .unauthorized,
        402 => .payment_required,
        403 => .forbidden,
        404, 410 => .not_found,
        else => .unavailable,
    };
}

/// Whether a failed Pantry lookup may be followed by an npm lookup of the same
/// name.
///
/// Never for a pinned scope. For any other name, not when the registry said
/// the name exists and is gated (401/402/403): that is a private or paid
/// Pantry package, and npm's package of the same name - if there is one - is
/// somebody else's. A plain miss or an unreachable registry keeps the existing
/// fallback, so public npm installs do not depend on Pantry being up.
pub fn allowsNpmFallback(pinned: bool, failure: Failure) bool {
    if (pinned) return false;
    return switch (failure) {
        .unauthorized, .payment_required, .forbidden => false,
        else => true,
    };
}

pub const ResolveError = error{
    PinnedUnauthorized,
    PinnedPaymentRequired,
    PinnedForbidden,
    PinnedNotFound,
    PinnedNoMatchingVersion,
    PinnedInvalidRange,
    PinnedUnavailable,
    PinnedInvalidResponse,
    PinnedIntegrityConflict,
    OutOfMemory,
};

pub fn failureError(failure: Failure) ResolveError {
    return switch (failure) {
        .unauthorized => error.PinnedUnauthorized,
        .payment_required => error.PinnedPaymentRequired,
        .forbidden => error.PinnedForbidden,
        .not_found => error.PinnedNotFound,
        .no_matching_version => error.PinnedNoMatchingVersion,
        .invalid_range => error.PinnedInvalidRange,
        .unavailable => error.PinnedUnavailable,
        .invalid_response => error.PinnedInvalidResponse,
        .integrity_conflict => error.PinnedIntegrityConflict,
    };
}

/// The failure an error from `resolve` stands for; null for unrelated errors.
pub fn errorFailure(err: anyerror) ?Failure {
    return switch (err) {
        error.PinnedUnauthorized => .unauthorized,
        error.PinnedPaymentRequired => .payment_required,
        error.PinnedForbidden => .forbidden,
        error.PinnedNotFound => .not_found,
        error.PinnedNoMatchingVersion => .no_matching_version,
        error.PinnedInvalidRange => .invalid_range,
        error.PinnedUnavailable => .unavailable,
        error.PinnedInvalidResponse => .invalid_response,
        error.PinnedIntegrityConflict => .integrity_conflict,
        else => null,
    };
}

fn isAnyVersion(constraint: []const u8) bool {
    return constraint.len == 0 or std.mem.eql(u8, constraint, "latest") or std.mem.eql(u8, constraint, "*");
}

/// Versions travel into URLs, so only the characters a version can contain.
pub fn isSafeVersion(version: []const u8) bool {
    if (version.len == 0 or version.len > 64) return false;
    for (version) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '.' or c == '_' or c == '+' or c == '-')) return false;
    }
    return true;
}

/// A bare major or major.minor (`1`, `1.2`) or an x-range (`1.x`, `1.2.*`)
/// rewritten as the equivalent bounds. Null when `constraint` is neither.
fn xRangeBounds(buf: []u8, constraint: []const u8) ?[]const u8 {
    var parts: [3]?u32 = .{ null, null, null };
    var count: usize = 0;
    var it = std.mem.splitScalar(u8, constraint, '.');
    while (it.next()) |part| {
        if (count == 3) return null;
        if (part.len == 1 and (part[0] == 'x' or part[0] == 'X' or part[0] == '*')) {
            count += 1;
            continue;
        }
        if (part.len == 0) return null;
        for (part) |c| if (!std.ascii.isDigit(c)) return null;
        // A wildcard followed by a number (`1.x.3`) is not a range.
        if (count > 0 and parts[count - 1] == null) return null;
        parts[count] = std.fmt.parseInt(u32, part, 10) catch return null;
        count += 1;
    }
    if (count == 0 or parts[0] == null) return null;
    // Three numbers is an exact version, not an x-range.
    if (count == 3 and parts[2] != null) return null;
    const major = parts[0].?;
    if (count >= 2 and parts[1] != null) {
        const minor = parts[1].?;
        return std.fmt.bufPrint(buf, ">={d}.{d}.0 <{d}.{d}.0", .{ major, minor, major, minor + 1 }) catch null;
    }
    return std.fmt.bufPrint(buf, ">={d}.0.0 <{d}.0.0", .{ major, major + 1 }) catch null;
}

/// Whether `version` satisfies `constraint` (npm syntax: exact, `^`, `~`,
/// comparators, `x`-ranges, `||`, `latest`/`*`).
pub fn satisfies(version: []const u8, constraint_in: []const u8) error{InvalidRange}!bool {
    const constraint = std.mem.trim(u8, constraint_in, &std.ascii.whitespace);
    if (isAnyVersion(constraint)) return true;

    if (std.mem.indexOf(u8, constraint, "||") != null) {
        var alternatives = std.mem.splitSequence(u8, constraint, "||");
        while (alternatives.next()) |alt| {
            if (try satisfies(version, alt)) return true;
        }
        return false;
    }

    var exact = constraint;
    if (exact.len > 0 and exact[0] == '=') exact = std.mem.trimStart(u8, exact[1..], " ");
    if (exact.len > 0 and exact[0] == 'v') exact = exact[1..];
    if (std.mem.eql(u8, exact, version)) return true;

    var bounds_buf: [64]u8 = undefined;
    const effective = xRangeBounds(&bounds_buf, exact) orelse constraint;
    if (exact.len > 0 and std.ascii.isDigit(exact[0]) and effective.ptr == constraint.ptr) {
        // An exact version that is not this one.
        if (std.mem.indexOfAny(u8, exact, " <>^~") == null) {
            _ = semver.parseVersion(exact) catch return error.InvalidRange;
            return semver.compareVersions(exact, version) == .eq;
        }
    }
    const parsed = semver.parseConstraint(effective) catch return error.InvalidRange;
    return semver.satisfiesConstraint(version, parsed);
}

/// The version a constraint selects from the registry's list: the highest
/// satisfying one, stable releases preferred for `latest`. `preferred` (the
/// lockfile's pin) wins whenever it is listed and still satisfies.
pub fn selectVersion(versions: []const []const u8, constraint_in: []const u8, preferred: ?[]const u8) error{InvalidRange}!?[]const u8 {
    const constraint = std.mem.trim(u8, constraint_in, &std.ascii.whitespace);

    // A dist-tag other than `latest` names nothing in a version list.
    if (constraint.len > 0 and std.ascii.isAlphabetic(constraint[0]) and !std.mem.eql(u8, constraint, "latest") and constraint[0] != 'v')
        return error.InvalidRange;

    if (preferred) |pin| {
        for (versions) |v| {
            if (std.mem.eql(u8, v, pin) and try satisfies(v, constraint)) return v;
        }
    }

    var best: ?[]const u8 = null;
    if (isAnyVersion(constraint)) {
        // Highest stable release; a prerelease only when nothing else exists.
        for (versions) |v| {
            if (semver.isPrerelease(v)) continue;
            if (best == null or semver.compareVersions(v, best.?) == .gt) best = v;
        }
        if (best != null) return best;
        for (versions) |v| {
            if (best == null or semver.compareVersions(v, best.?) == .gt) best = v;
        }
        return best;
    }

    for (versions) |v| {
        if (!(try satisfies(v, constraint))) continue;
        if (best == null or semver.compareVersions(v, best.?) == .gt) best = v;
    }
    return best;
}

/// Lock integrity and registry integrity name the same bytes.
pub fn integrityEqual(a: []const u8, b: []const u8) bool {
    return std.ascii.eqlIgnoreCase(std.mem.trim(u8, a, " "), std.mem.trim(u8, b, " "));
}

/// The registry's `checksum` as a lockfile integrity value, when it is one we
/// can verify: `sha256:<hex>` (what Pantry stores) or an SRI string.
pub fn integrityFromChecksum(checksum: []const u8) ?[]const u8 {
    const value = std.mem.trim(u8, checksum, &std.ascii.whitespace);
    if (std.mem.startsWith(u8, value, "sha256:") and value.len == 7 + 64) {
        for (value[7..]) |c| if (!std.ascii.isHex(c)) return null;
        return value;
    }
    if (std.mem.startsWith(u8, value, "sha512-") or std.mem.startsWith(u8, value, "sha256-")) return value;
    return null;
}

/// `sha256:<hex>` of a tarball: what a lockfile records for a Pantry package
/// whose registry entry carried no checksum.
pub fn sha256Integrity(allocator: std.mem.Allocator, bytes: []const u8) ![]const u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    const hex = std.fmt.bytesToHex(digest, .lower);
    return std.fmt.allocPrint(allocator, "sha256:{s}", .{&hex});
}

/// `https://registry.pantry.dev/x` → `registry.pantry.dev`.
pub fn hostOf(base: []const u8) []const u8 {
    const after_scheme = if (std.mem.indexOf(u8, base, "://")) |i| base[i + 3 ..] else base;
    const end = std.mem.indexOfScalar(u8, after_scheme, '/') orelse after_scheme.len;
    return after_scheme[0..end];
}

/// What to print when a Pantry lookup fails and nothing else may be tried.
pub fn describeFailure(
    allocator: std.mem.Allocator,
    failure: Failure,
    name: []const u8,
    constraint: []const u8,
    base: []const u8,
    has_token: bool,
    pinned_scope: ?[]const u8,
) ![]const u8 {
    const host = hostOf(base);
    const spec = if (isAnyVersion(constraint))
        try allocator.dupe(u8, name)
    else
        try std.fmt.allocPrint(allocator, "{s}@{s}", .{ name, constraint });
    defer allocator.free(spec);

    const body = switch (failure) {
        .unauthorized => if (has_token)
            try std.fmt.allocPrint(allocator, "{s} is private on {s} and the token sent was rejected (401). It may be expired or revoked: set PANTRY_REGISTRY_TOKEN to a current token with access.", .{ spec, host })
        else
            try std.fmt.allocPrint(allocator, "{s} is private on {s} (401). Set PANTRY_REGISTRY_TOKEN to a token with access.", .{ spec, host }),
        .payment_required => try std.fmt.allocPrint(allocator, "{s} is a paid package on {s} (402). Buy access with: pantry buy {s}", .{ spec, host, name }),
        .forbidden => try std.fmt.allocPrint(allocator, "{s} is private on {s} and this token has no access to it (403). Ask its publisher for access (pantry access grant {s} <email>) or for a package token.", .{ spec, host, name }),
        .not_found => if (has_token)
            try std.fmt.allocPrint(allocator, "{s} is not available from {s} (404). Check the name, and that your token has access to it.", .{ spec, host })
        else
            try std.fmt.allocPrint(allocator, "{s} is not available from {s} (404). It is private: set PANTRY_REGISTRY_TOKEN to a token with access.", .{ spec, host }),
        .no_matching_version => try std.fmt.allocPrint(allocator, "no version of {s} on {s} satisfies {s}.", .{ name, host, if (constraint.len == 0) "latest" else constraint }),
        .invalid_range => try std.fmt.allocPrint(allocator, "\"{s}\" is not a version or range pantry can resolve for {s} (use an exact version, ^, ~, comparators or latest).", .{ constraint, name }),
        .unavailable => try std.fmt.allocPrint(allocator, "could not reach {s} to resolve {s}.", .{ host, spec }),
        .invalid_response => try std.fmt.allocPrint(allocator, "{s} answered for {s} with something that is not Pantry package metadata.", .{ host, spec }),
        .integrity_conflict => try std.fmt.allocPrint(allocator, "{s} on {s} no longer matches the integrity recorded in pantry.lock. Refusing to install it; if the change is expected, remove its pantry.lock entry.", .{ spec, host }),
    };
    if (pinned_scope) |scope| {
        defer allocator.free(body);
        return std.fmt.allocPrint(allocator, "{s} {s} is pinned to {s} in \"scopes\"; no other registry was tried.", .{ body, scope, host });
    }
    return body;
}

// ---------------------------------------------------------------------------
// Resolution (network)
// ---------------------------------------------------------------------------

pub const Dependency = struct {
    name: []const u8,
    constraint: []const u8,
    optional: bool = false,
};

pub const Resolution = struct {
    version: []const u8,
    tarball_url: []const u8,
    /// `sha256:<hex>` (or SRI) from the registry's checksum or pantry.lock.
    integrity: ?[]const u8 = null,
    /// Read from the published manifest the registry stores with the version.
    dependencies: []Dependency = &.{},

    pub fn deinit(self: *Resolution, allocator: std.mem.Allocator) void {
        allocator.free(self.version);
        allocator.free(self.tarball_url);
        if (self.integrity) |i| allocator.free(i);
        for (self.dependencies) |d| {
            allocator.free(d.name);
            allocator.free(d.constraint);
        }
        allocator.free(self.dependencies);
    }
};

pub const ResolveOptions = struct {
    /// pantry.lock's version for this name, kept when it still satisfies.
    locked_version: ?[]const u8 = null,
    /// pantry.lock's integrity for `locked_version`.
    locked_integrity: ?[]const u8 = null,
    timeout_ms: u64 = 30_000,
};

/// `@hq/platform` → `@hq%2Fplatform`, the spelling the CLI's other
/// `/packages/{name}` calls use.
pub fn encodeName(allocator: std.mem.Allocator, name: []const u8) ![]u8 {
    return auth_registry.urlEncodePackageName(allocator, name);
}

pub fn packageUrl(allocator: std.mem.Allocator, base: []const u8, name: []const u8, suffix: []const u8) ![]u8 {
    const encoded = try encodeName(allocator, name);
    defer allocator.free(encoded);
    return std.fmt.allocPrint(allocator, "{s}/packages/{s}{s}", .{ base, encoded, suffix });
}

/// `{ "versions": ["1.0.0", …] }` (or objects carrying `version`) → owned
/// list of URL-safe version strings.
pub fn parseVersionsBody(allocator: std.mem.Allocator, body: []const u8) ![][]const u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, body, .{}) catch return error.InvalidResponse;
    defer parsed.deinit();

    const list = switch (parsed.value) {
        .array => parsed.value,
        .object => |obj| obj.get("versions") orelse return error.InvalidResponse,
        else => return error.InvalidResponse,
    };
    if (list != .array) return error.InvalidResponse;

    var out: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (out.items) |v| allocator.free(v);
        out.deinit(allocator);
    }
    for (list.array.items) |item| {
        const version = switch (item) {
            .string => |s| s,
            .object => |obj| if (obj.get("version")) |v| (if (v == .string) v.string else continue) else continue,
            else => continue,
        };
        if (!isSafeVersion(version)) continue;
        try out.append(allocator, try allocator.dupe(u8, version));
    }
    return out.toOwnedSlice(allocator);
}

pub fn freeVersions(allocator: std.mem.Allocator, versions: [][]const u8) void {
    for (versions) |v| allocator.free(v);
    allocator.free(versions);
}

/// Parse `GET /packages/{name}/{version}` into a resolution whose tarball is
/// the registry's canonical `/packages/{name}/{version}/tarball` route.
///
/// The registry proxies npm for names it does not publish; an answer whose
/// tarball lives on npm is a miss, not a Pantry package.
pub fn parseVersionMetadata(
    allocator: std.mem.Allocator,
    body: []const u8,
    base: []const u8,
    name: []const u8,
    version: []const u8,
) error{ NotPantryPackage, InvalidResponse, OutOfMemory }!Resolution {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, body, .{}) catch return error.InvalidResponse;
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidResponse;
    const obj = parsed.value.object;
    if (obj.get("error") != null) return error.InvalidResponse;

    if (obj.get("tarballUrl")) |t| {
        if (t == .string and std.mem.indexOf(u8, t.string, "registry.npmjs.org") != null) return error.NotPantryPackage;
    }
    if (obj.get("dist")) |d| {
        // npm's own document shape, relayed by a proxy.
        if (d == .object) {
            if (d.object.get("tarball")) |t| {
                if (t == .string and std.mem.indexOf(u8, t.string, "registry.npmjs.org") != null) return error.NotPantryPackage;
            }
        }
    }
    if (obj.get("version")) |v| {
        if (v != .string or !std.mem.eql(u8, v.string, version)) return error.InvalidResponse;
    }

    const integrity: ?[]const u8 = blk: {
        if (obj.get("checksum")) |c| {
            if (c == .string) {
                if (integrityFromChecksum(c.string)) |i| break :blk try allocator.dupe(u8, i);
            }
        }
        if (obj.get("integrity")) |c| {
            if (c == .string) {
                if (integrityFromChecksum(c.string)) |i| break :blk try allocator.dupe(u8, i);
            }
        }
        break :blk null;
    };
    errdefer if (integrity) |i| allocator.free(i);

    var deps: std.ArrayList(Dependency) = .empty;
    errdefer {
        for (deps.items) |d| {
            allocator.free(d.name);
            allocator.free(d.constraint);
        }
        deps.deinit(allocator);
    }
    for ([_][]const u8{ "dependencies", "optionalDependencies" }) |section| {
        const section_val = obj.get(section) orelse continue;
        if (section_val != .object) continue;
        var it = section_val.object.iterator();
        while (it.next()) |entry| {
            if (entry.value_ptr.* != .string) continue;
            if (std.mem.startsWith(u8, entry.value_ptr.string, "workspace:")) continue;
            const dep_name = try allocator.dupe(u8, entry.key_ptr.*);
            errdefer allocator.free(dep_name);
            const dep_constraint = try allocator.dupe(u8, entry.value_ptr.string);
            errdefer allocator.free(dep_constraint);
            try deps.append(allocator, .{
                .name = dep_name,
                .constraint = dep_constraint,
                .optional = std.mem.eql(u8, section, "optionalDependencies"),
            });
        }
    }

    const tarball_url = try packageUrl(allocator, base, name, "");
    defer allocator.free(tarball_url);
    const canonical = try std.fmt.allocPrint(allocator, "{s}/{s}/tarball", .{ tarball_url, version });
    errdefer allocator.free(canonical);
    const owned_version = try allocator.dupe(u8, version);
    errdefer allocator.free(owned_version);

    return .{
        .version = owned_version,
        .tarball_url = canonical,
        .integrity = integrity,
        .dependencies = try deps.toOwnedSlice(allocator),
    };
}

/// Resolve `name@constraint` against the Pantry registry at `base`, and only
/// there. Every failure is an error naming what went wrong; see
/// `describeFailure` for the message.
pub fn resolve(
    allocator: std.mem.Allocator,
    base: []const u8,
    name: []const u8,
    constraint: []const u8,
    opts: ResolveOptions,
) ResolveError!Resolution {
    const versions_url = try packageUrl(allocator, base, name, "/versions");
    defer allocator.free(versions_url);

    const listing = io_helper.httpGetStatusTimeout(allocator, versions_url, opts.timeout_ms) catch return error.PinnedUnavailable;
    defer listing.deinit(allocator);
    if (classifyStatus(listing.status)) |f| return failureError(f);

    const versions = parseVersionsBody(allocator, listing.body) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.PinnedInvalidResponse,
    };
    defer freeVersions(allocator, versions);
    if (versions.len == 0) return error.PinnedNotFound;

    const chosen = (selectVersion(versions, constraint, opts.locked_version) catch return error.PinnedInvalidRange) orelse
        return error.PinnedNoMatchingVersion;

    const meta_suffix = try std.fmt.allocPrint(allocator, "/{s}", .{chosen});
    defer allocator.free(meta_suffix);
    const meta_url = try packageUrl(allocator, base, name, meta_suffix);
    defer allocator.free(meta_url);

    const meta = io_helper.httpGetStatusTimeout(allocator, meta_url, opts.timeout_ms) catch return error.PinnedUnavailable;
    defer meta.deinit(allocator);
    if (classifyStatus(meta.status)) |f| return failureError(f);

    var resolution = parseVersionMetadata(allocator, meta.body, base, name, chosen) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.NotPantryPackage => return error.PinnedNotFound,
        error.InvalidResponse => return error.PinnedInvalidResponse,
    };
    errdefer resolution.deinit(allocator);

    try reconcileLockIntegrity(allocator, &resolution, opts);
    return resolution;
}

/// pantry.lock and the registry must agree about the bytes of a locked
/// version: the lock fills in a checksum the registry did not send, and a
/// disagreement is refused.
pub fn reconcileLockIntegrity(allocator: std.mem.Allocator, resolution: *Resolution, opts: ResolveOptions) ResolveError!void {
    const locked_version = opts.locked_version orelse return;
    const locked_integrity = opts.locked_integrity orelse return;
    if (!std.mem.eql(u8, locked_version, resolution.version)) return;
    if (resolution.integrity) |current| {
        if (!integrityEqual(current, locked_integrity)) return error.PinnedIntegrityConflict;
    } else {
        resolution.integrity = try allocator.dupe(u8, locked_integrity);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

fn parseScopesText(cfg: *Config, text: []const u8, kind: ManifestKind, diag: *Diagnostic) !void {
    try parseManifest(cfg, testing.allocator, text, kind, diag);
}

test "scopes: pantry.json pins a scope to the Pantry registry or a URL" {
    var cfg = Config.init(testing.allocator);
    defer cfg.deinit();
    var diag: Diagnostic = .{};
    try parseScopesText(&cfg,
        \\{
        \\  // JSONC is fine
        \\  "scopes": { "@hq": "pantry", "@acme/": "https://registry.acme.test/" },
        \\  "dependencies": { "@hq/platform": "^1.4.0" }
        \\}
    , .pantry, &diag);

    try testing.expectEqual(@as(usize, 2), cfg.pins.len);
    const hq = cfg.pinFor("@hq/platform").?;
    try testing.expectEqualStrings("@hq", hq.scope);
    try testing.expectEqualStrings("pantry", hq.registry);
    try testing.expectEqualStrings(endpoint.baseUrl(), hq.baseUrl());

    const acme = cfg.pinFor("@acme/sdk").?;
    try testing.expectEqualStrings("@acme", acme.scope);
    try testing.expectEqualStrings("https://registry.acme.test", acme.baseUrl());

    // Scope comparison folds case; unscoped and other scopes are not pinned.
    try testing.expect(cfg.pinFor("@HQ/platform") != null);
    try testing.expect(cfg.pinFor("@hqx/platform") == null);
    try testing.expect(cfg.pinFor("platform") == null);
    try testing.expect(cfg.pinFor("@hq") == null);
}

test "scopes: package.json reads only the pantry namespace" {
    var cfg = Config.init(testing.allocator);
    defer cfg.deinit();
    var diag: Diagnostic = .{};
    try parseScopesText(&cfg,
        \\{ "scopes": { "@other": "pantry" }, "pantry": { "scopes": { "@hq": "PANTRY" } } }
    , .package_json, &diag);
    try testing.expectEqual(@as(usize, 1), cfg.pins.len);
    try testing.expect(cfg.pinFor("@hq/platform") != null);
    try testing.expect(cfg.pinFor("@other/x") == null);
}

test "scopes: a malformed pin is an error, never silently dropped" {
    const bad = [_][]const u8{
        \\{ "scopes": { "hq": "pantry" } }
        ,
        \\{ "scopes": { "@hq/platform": "pantry" } }
        ,
        \\{ "scopes": { "@hq": "npm" } }
        ,
        \\{ "scopes": { "@hq": "ftp://registry.example.com" } }
        ,
        \\{ "scopes": { "@hq": 1 } }
        ,
        \\{ "scopes": ["@hq"] }
        ,
    };
    for (bad) |text| {
        var cfg = Config.init(testing.allocator);
        defer cfg.deinit();
        var diag: Diagnostic = .{};
        try testing.expectError(error.InvalidScopesConfig, parseScopesText(&cfg, text, .pantry, &diag));
        try testing.expect(diag.message().len > 0);
    }
}

test "scopes: first declaration of a scope wins" {
    var cfg = Config.init(testing.allocator);
    defer cfg.deinit();
    var diag: Diagnostic = .{};
    try parseScopesText(&cfg,
        \\{ "scopes": { "@hq": "https://one.example.com" } }
    , .pantry, &diag);
    try parseScopesText(&cfg,
        \\{ "pantry": { "scopes": { "@hq": "pantry" } } }
    , .package_json, &diag);
    try testing.expectEqualStrings("https://one.example.com", cfg.pinFor("@hq/x").?.registry);
}

test "scopes: loadForProject merges pantry.json over package.json" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realPathFileAlloc(io_helper.io, ".", testing.allocator);
    defer testing.allocator.free(dir);

    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.json", .data =
        \\{ "scopes": { "@hq": "pantry" } }
    });
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data =
        \\{ "pantry": { "scopes": { "@hq": "https://elsewhere.example.com", "@acme": "pantry" } } }
    });

    var diag: Diagnostic = .{};
    var cfg = try loadForProject(testing.allocator, dir, &diag);
    defer cfg.deinit();
    try testing.expectEqualStrings("pantry", cfg.pinFor("@hq/platform").?.registry);
    try testing.expect(cfg.pinFor("@acme/x") != null);
}

test "scopes: scopeOf" {
    try testing.expectEqualStrings("@hq", scopeOf("@hq/platform").?);
    try testing.expect(scopeOf("platform") == null);
    try testing.expect(scopeOf("@/x") == null);
    try testing.expect(scopeOf("@hq") == null);
}

test "pinned resolution: no failure of a pinned scope ever falls back" {
    inline for (@typeInfo(Failure).@"enum".field_names) |field_name| {
        try testing.expect(!allowsNpmFallback(true, @field(Failure, field_name)));
    }
}

test "pinned resolution: an unpinned name gated by Pantry does not fall back to npm" {
    try testing.expect(!allowsNpmFallback(false, classifyStatus(401).?));
    try testing.expect(!allowsNpmFallback(false, classifyStatus(402).?));
    try testing.expect(!allowsNpmFallback(false, classifyStatus(403).?));
    // A miss or an outage keeps public npm installs working.
    try testing.expect(allowsNpmFallback(false, classifyStatus(404).?));
    try testing.expect(allowsNpmFallback(false, classifyStatus(503).?));
    try testing.expect(allowsNpmFallback(false, .unavailable));
    try testing.expect(classifyStatus(200) == null);
    try testing.expect(classifyStatus(204) == null);
}

test "pinned resolution: errors and failures round-trip" {
    inline for (@typeInfo(Failure).@"enum".field_names) |field_name| {
        const f = @field(Failure, field_name);
        try testing.expectEqual(f, errorFailure(failureError(f)).?);
    }
    try testing.expect(errorFailure(error.FileNotFound) == null);
}

test "pinned resolution: an exact pin selects exactly that version" {
    const versions = [_][]const u8{ "1.2.0", "1.3.0", "1.4.0", "2.0.0-beta.1" };
    try testing.expectEqualStrings("1.2.0", (try selectVersion(&versions, "1.2.0", null)).?);
    try testing.expectEqualStrings("1.2.0", (try selectVersion(&versions, "=1.2.0", null)).?);
    try testing.expectEqualStrings("1.2.0", (try selectVersion(&versions, "v1.2.0", null)).?);
    try testing.expectEqualStrings("2.0.0-beta.1", (try selectVersion(&versions, "2.0.0-beta.1", null)).?);
    // Not published: nothing, rather than the nearest thing.
    try testing.expect((try selectVersion(&versions, "1.2.1", null)) == null);
}

test "pinned resolution: a range selects the highest satisfying version" {
    const versions = [_][]const u8{ "1.2.0", "1.4.0", "1.3.9", "2.0.0", "2.1.0-rc.1" };
    try testing.expectEqualStrings("1.4.0", (try selectVersion(&versions, "^1.2.0", null)).?);
    try testing.expectEqualStrings("1.3.9", (try selectVersion(&versions, "~1.3.0", null)).?);
    try testing.expectEqualStrings("1.4.0", (try selectVersion(&versions, ">=1.2.0 <2.0.0", null)).?);
    try testing.expectEqualStrings("2.0.0", (try selectVersion(&versions, "^1.0.0 || ^2.0.0", null)).?);
    try testing.expectEqualStrings("1.4.0", (try selectVersion(&versions, "1.x", null)).?);
    try testing.expectEqualStrings("1.4.0", (try selectVersion(&versions, "1", null)).?);
    try testing.expectEqualStrings("1.3.9", (try selectVersion(&versions, "1.3", null)).?);
    // latest is the highest stable release, never a prerelease.
    try testing.expectEqualStrings("2.0.0", (try selectVersion(&versions, "latest", null)).?);
    try testing.expectEqualStrings("2.0.0", (try selectVersion(&versions, "", null)).?);
    try testing.expectEqualStrings("2.0.0", (try selectVersion(&versions, "*", null)).?);
    // A range nothing satisfies.
    try testing.expect((try selectVersion(&versions, "^3.0.0", null)) == null);
    // A prerelease only when nothing stable exists.
    const only_pre = [_][]const u8{ "0.1.0-alpha.1", "0.1.0-alpha.2" };
    try testing.expectEqualStrings("0.1.0-alpha.2", (try selectVersion(&only_pre, "latest", null)).?);
}

test "pinned resolution: the lockfile's pin wins while it satisfies" {
    const versions = [_][]const u8{ "1.2.0", "1.4.0" };
    try testing.expectEqualStrings("1.2.0", (try selectVersion(&versions, "^1.0.0", "1.2.0")).?);
    // Out of range or no longer listed: resolve afresh.
    try testing.expectEqualStrings("1.4.0", (try selectVersion(&versions, "^1.3.0", "1.2.0")).?);
    try testing.expectEqualStrings("1.4.0", (try selectVersion(&versions, "^1.0.0", "1.1.0")).?);
}

test "pinned resolution: dist-tags other than latest are refused" {
    const versions = [_][]const u8{"1.0.0"};
    try testing.expectError(error.InvalidRange, selectVersion(&versions, "next", null));
    try testing.expectError(error.InvalidRange, selectVersion(&versions, "^not.a.version", null));
}

test "pinned resolution: versions body parsing keeps only URL-safe versions" {
    const versions = try parseVersionsBody(testing.allocator,
        \\{"versions":["1.0.0","1.1.0",{"version":"1.2.0"},"../../etc","1.3.0?x=1",7]}
    );
    defer freeVersions(testing.allocator, versions);
    try testing.expectEqual(@as(usize, 3), versions.len);
    try testing.expectEqualStrings("1.2.0", versions[2]);
    try testing.expectError(error.InvalidResponse, parseVersionsBody(testing.allocator, "<html>"));
}

test "pinned resolution: metadata yields the canonical tarball, integrity and deps" {
    const body =
        \\{"name":"@hq/platform","version":"1.4.0",
        \\ "tarballUrl":"https://registry.pantry.dev/packages/%40hq%2Fplatform/1.4.0/tarball",
        \\ "checksum":"sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        \\ "dependencies":{"@hq/tokens":"^2.0.0","left-pad":"1.3.0","local":"workspace:*"},
        \\ "optionalDependencies":{"fsevents":"^2"},
        \\ "publishConfig":{"access":"restricted"}}
    ;
    var res = try parseVersionMetadata(testing.allocator, body, "https://registry.pantry.dev", "@hq/platform", "1.4.0");
    defer res.deinit(testing.allocator);
    try testing.expectEqualStrings("1.4.0", res.version);
    try testing.expectEqualStrings("https://registry.pantry.dev/packages/@hq%2Fplatform/1.4.0/tarball", res.tarball_url);
    try testing.expectEqualStrings("sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9", res.integrity.?);
    try testing.expectEqual(@as(usize, 3), res.dependencies.len);
    try testing.expect(res.dependencies[2].optional);
}

test "pinned resolution: an npm answer relayed by the registry is a miss" {
    const relayed =
        \\{"name":"@hq/platform","version":"1.4.0","tarballUrl":"https://registry.npmjs.org/@hq/platform/-/platform-1.4.0.tgz"}
    ;
    try testing.expectError(error.NotPantryPackage, parseVersionMetadata(testing.allocator, relayed, "https://registry.pantry.dev", "@hq/platform", "1.4.0"));
    // A different version than asked for is not an answer either.
    try testing.expectError(error.InvalidResponse, parseVersionMetadata(testing.allocator,
        \\{"version":"9.9.9"}
    , "https://registry.pantry.dev", "@hq/platform", "1.4.0"));
}

test "pinned resolution: lock integrity fills gaps and refuses conflicts" {
    const allocator = testing.allocator;
    const locked = "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

    var missing = Resolution{ .version = try allocator.dupe(u8, "1.4.0"), .tarball_url = try allocator.dupe(u8, "u"), .dependencies = try allocator.alloc(Dependency, 0) };
    defer missing.deinit(allocator);
    try reconcileLockIntegrity(allocator, &missing, .{ .locked_version = "1.4.0", .locked_integrity = locked });
    try testing.expectEqualStrings(locked, missing.integrity.?);

    var changed = Resolution{
        .version = try allocator.dupe(u8, "1.4.0"),
        .tarball_url = try allocator.dupe(u8, "u"),
        .integrity = try allocator.dupe(u8, "sha256:0000000000000000000000000000000000000000000000000000000000000000"),
        .dependencies = try allocator.alloc(Dependency, 0),
    };
    defer changed.deinit(allocator);
    try testing.expectError(error.PinnedIntegrityConflict, reconcileLockIntegrity(allocator, &changed, .{ .locked_version = "1.4.0", .locked_integrity = locked }));
    // A different locked version says nothing about this one.
    try reconcileLockIntegrity(allocator, &changed, .{ .locked_version = "1.3.0", .locked_integrity = locked });
}

test "pinned resolution: integrity strings" {
    try testing.expect(integrityFromChecksum("sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9") != null);
    try testing.expect(integrityFromChecksum("sha256:short") == null);
    try testing.expect(integrityFromChecksum("") == null);
    try testing.expect(integrityFromChecksum("sha512-abc") != null);

    const recorded = try sha256Integrity(testing.allocator, "hello world");
    defer testing.allocator.free(recorded);
    try testing.expectEqualStrings("sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9", recorded);
}

test "pinned resolution: URLs encode the scope separator" {
    const url = try packageUrl(testing.allocator, "https://registry.example.com", "@hq/platform", "/versions");
    defer testing.allocator.free(url);
    try testing.expectEqualStrings("https://registry.example.com/packages/@hq%2Fplatform/versions", url);
    try testing.expectEqualStrings("registry.example.com", hostOf("https://registry.example.com/x"));
}

test "pinned resolution: failure messages say what to do" {
    const allocator = testing.allocator;
    const msg = try describeFailure(allocator, .not_found, "@hq/platform", "1.4.0", "https://registry.pantry.dev", false, "@hq");
    defer allocator.free(msg);
    try testing.expect(std.mem.indexOf(u8, msg, "@hq/platform@1.4.0 is not available from registry.pantry.dev (404). It is private: set PANTRY_REGISTRY_TOKEN") != null);
    try testing.expect(std.mem.indexOf(u8, msg, "no other registry was tried") != null);

    const paid = try describeFailure(allocator, .payment_required, "@hq/platform", "latest", "https://registry.pantry.dev", true, null);
    defer allocator.free(paid);
    try testing.expect(std.mem.indexOf(u8, paid, "pantry buy @hq/platform") != null);

    const rejected = try describeFailure(allocator, .unauthorized, "@hq/platform", "^1", "https://registry.pantry.dev", true, null);
    defer allocator.free(rejected);
    try testing.expect(std.mem.indexOf(u8, rejected, "rejected (401)") != null);
}
