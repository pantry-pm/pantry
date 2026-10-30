//! Which registry this machine talks to, and how it authenticates to it.
//!
//! Two things a self-hosted registry needs from the client, both of which have
//! to apply to *every* HTTP call the CLI makes rather than to the handful of
//! call sites someone remembers to update:
//!
//!   1. **Where to look.** `PANTRY_REGISTRY_URL=https://registry.example.com`
//!      redirects requests aimed at the default registry to yours. The URLs are
//!      still built as `https://registry.pantry.dev/...` all over the install
//!      path; they are rewritten as the request goes out.
//!
//!   2. **Who is asking.** A private registry serves nothing without a
//!      credential, so requests to your registry carry
//!      `Authorization: Bearer <token>` — the token stored by
//!      `pantry token set --registry https://registry.example.com`, or
//!      `PANTRY_REGISTRY_TOKEN` / `PANTRY_TOKEN` from the environment.
//!
//! A token only ever goes to the registry that issued it: the origin matches
//! `PANTRY_REGISTRY_URL`, or `~/.pantry/credentials` holds an entry scoped to
//! exactly that origin, or it is the public registry a `PANTRY_TOKEN` belongs
//! to (which is what identifies the account that bought a paid package). It is
//! never broadcast to third-party hosts — npm, GitHub, or the object-storage
//! host a download redirects to.
//!
//! `io_helper` calls in here through a function pointer (installed in `main`)
//! so the low-level HTTP code doesn't have to know about the credential store.

const std = @import("std");
const io_helper = @import("../io_helper.zig");
const token_commands = @import("../cli/commands/token.zig");

/// The registry used when nothing else is configured.
pub const default_base = "https://registry.pantry.dev";

/// Environment variable naming the registry to talk to.
pub const url_env = "PANTRY_REGISTRY_URL";

const Scoped = struct {
    origin: []const u8,
    token: []const u8,
};

const Resolved = struct {
    /// Configured base URL, trailing slash removed. Null ⇒ the default registry.
    base: ?[]const u8 = null,
    /// `scheme://host[:port]` of `base`.
    base_origin: ?[]const u8 = null,
    /// Credential for `base`, if we have one.
    base_token: ?[]const u8 = null,
    /// Per-origin credentials from `~/.pantry/credentials` sections.
    scoped: []const Scoped = &.{},
    /// Credential for the default registry, when one is stored. Paid packages
    /// and any private package on the public registry are served against an
    /// account, so the token has to travel — to its own issuer and nowhere else.
    default_token: ?[]const u8 = null,
    /// `default_token` came from PANTRY_REGISTRY_TOKEN / PANTRY_TOKEN. Set
    /// for a run, it outranks a credential stored in the file, as it does for
    /// `pantry publish`: a CI job's package token must not lose to a personal
    /// token left in ~/.pantry/credentials.
    default_from_env: bool = false,
    /// Registries a project pinned a scope to (`"scopes"` in pantry.json),
    /// with the credential each one gets. See `trustPinnedRegistry`.
    pinned: []const Scoped = &.{},
};

var resolve_mutex: io_helper.Mutex = .{};
var resolved: ?Resolved = null;

/// Process-lifetime cache. The CLI makes hundreds of requests per install and
/// re-reading the credentials file for each one would be silly; it also means
/// the file is read once, under one lock, rather than from every worker thread.
fn config() Resolved {
    resolve_mutex.lock();
    defer resolve_mutex.unlock();
    if (resolved) |cached| return cached;

    const allocator = std.heap.page_allocator;
    var out = Resolved{};

    if (io_helper.getEnvVarOwned(allocator, url_env)) |raw| {
        const trimmed = std.mem.trimEnd(u8, std.mem.trim(u8, raw, &std.ascii.whitespace), "/");
        if (trimmed.len > 0 and std.mem.indexOf(u8, trimmed, "://") != null) {
            out.base = allocator.dupe(u8, trimmed) catch null;
            if (out.base) |base| {
                out.base_origin = originOf(base);
                if (token_commands.resolve(allocator, null, base, token_commands.default_key)) |maybe| {
                    if (maybe) |token| out.base_token = token.value;
                } else |_| {}
            }
        }
        allocator.free(raw);
    } else |_| {}

    out.scoped = loadScoped(allocator) catch &.{};

    if (token_commands.resolve(allocator, null, default_base, token_commands.default_key)) |maybe| {
        if (maybe) |token| {
            out.default_token = token.value;
            out.default_from_env = token.source == .env;
        }
    } else |_| {}

    resolved = out;
    return out;
}

/// Credentials explicitly scoped to a registry — `[https://…]` sections in the
/// credentials file. An entry here is a statement of intent: this token belongs
/// to that origin, so it is safe to send there and nowhere else.
fn loadScoped(allocator: std.mem.Allocator) ![]const Scoped {
    var store = token_commands.Store.load(allocator) catch return &.{};
    defer store.deinit();

    var list: std.ArrayList(Scoped) = .empty;
    errdefer list.deinit(allocator);

    for (store.entries.items) |entry| {
        const scope = entry.registry orelse continue;
        if (!std.mem.eql(u8, entry.key, token_commands.default_key)) continue;
        const origin = originOf(std.mem.trimEnd(u8, scope, "/")) orelse continue;
        try list.append(allocator, .{
            .origin = try allocator.dupe(u8, origin),
            .token = try allocator.dupe(u8, entry.value),
        });
    }

    return try list.toOwnedSlice(allocator);
}

/// `https://host:port/path?q` → `https://host:port`. Null when not a URL.
pub fn originOf(url: []const u8) ?[]const u8 {
    const scheme_end = std.mem.indexOf(u8, url, "://") orelse return null;
    const host_start = scheme_end + 3;
    if (host_start >= url.len) return null;
    const end = std.mem.indexOfScalarPos(u8, url, host_start, '/') orelse url.len;
    return url[0..end];
}

fn sameOrigin(a: []const u8, b: []const u8) bool {
    return std.ascii.eqlIgnoreCase(a, b);
}

/// The registry base URL in force: `PANTRY_REGISTRY_URL`, else the default.
pub fn baseUrl() []const u8 {
    return config().base orelse default_base;
}

/// Whether requests are pointed at a registry other than the public one.
pub fn isCustom() bool {
    return config().base != null;
}

/// What to change about an outgoing request: a replacement URL (when this
/// machine points at a registry other than the default) and/or an
/// `Authorization` value (when that registry is private). Defined by the HTTP
/// layer so it can hold the hook without importing this module.
pub const Decoration = io_helper.RequestDecoration;

/// Decide how to send a request to `url`. Never fails: on any error the request
/// goes out exactly as it would have before.
///
/// This is the function installed as `io_helper.decorate_request`.
pub fn decorate(allocator: std.mem.Allocator, url: []const u8) Decoration {
    var cfg = config();
    pinned_mutex.lock();
    defer pinned_mutex.unlock();
    cfg.pinned = pinned_list.items;
    return decorateWith(allocator, url, cfg);
}

/// Whether a request to `url` would carry a credential. Lets an error say
/// "your token was rejected" rather than "set a token" when one was sent.
pub fn hasCredentialFor(url: []const u8) bool {
    const allocator = std.heap.page_allocator;
    const dec = decorate(allocator, url);
    defer dec.deinit(allocator);
    return dec.authorization != null;
}

// ---------------------------------------------------------------------------
// Registries pinned by a project's `"scopes"`
// ---------------------------------------------------------------------------

var pinned_mutex: io_helper.Mutex = .{};
var pinned_list: std.ArrayList(Scoped) = .empty;

/// Let requests to a registry a project pinned a scope to carry a credential.
///
/// `"scopes": { "@acme": "https://registry.acme.example" }` names a registry
/// this machine may never have been configured for, and a private scope there
/// is unusable without a token. Which token goes, in order:
///
///   1. a `[https://registry.acme.example]` section in ~/.pantry/credentials —
///      a credential stored for exactly that registry;
///   2. `PANTRY_REGISTRY_TOKEN` / `PANTRY_TOKEN` from the environment — how CI
///      hands a client its read-only package token.
///
/// The global (unscoped) credentials entry is deliberately not sent: it is the
/// account token for the public registry, and a URL read from a repository's
/// manifest is not a reason to hand it to another host. Plain http is only
/// trusted for loopback hosts, so a token never crosses a network in clear.
pub fn trustPinnedRegistry(url: []const u8) void {
    const trimmed = std.mem.trimEnd(u8, std.mem.trim(u8, url, &std.ascii.whitespace), "/");
    const origin = originOf(trimmed) orelse return;
    if (!secureEnoughForToken(origin)) return;

    const allocator = std.heap.page_allocator;
    const token = pinnedCredential(allocator, trimmed) orelse return;

    pinned_mutex.lock();
    defer pinned_mutex.unlock();
    for (pinned_list.items) |entry| {
        if (sameOrigin(entry.origin, origin)) {
            allocator.free(token);
            return;
        }
    }
    const owned_origin = allocator.dupe(u8, origin) catch {
        allocator.free(token);
        return;
    };
    pinned_list.append(allocator, .{ .origin = owned_origin, .token = token }) catch {
        allocator.free(owned_origin);
        allocator.free(token);
    };
}

fn pinnedCredential(allocator: std.mem.Allocator, registry: []const u8) ?[]const u8 {
    if (token_commands.Store.load(allocator)) |loaded| {
        var store = loaded;
        defer store.deinit();
        if (store.get(token_commands.default_key, registry)) |entry| {
            if (entry.registry != null and entry.value.len > 0)
                return allocator.dupe(u8, entry.value) catch null;
        }
    } else |_| {}

    for (token_commands.env_names) |name| {
        if (io_helper.getEnvVarOwned(allocator, name)) |value| {
            if (value.len > 0) return value;
            allocator.free(value);
        } else |_| {}
    }
    return null;
}

/// https anywhere; http only to this machine.
pub fn secureEnoughForToken(origin: []const u8) bool {
    if (std.ascii.startsWithIgnoreCase(origin, "https://")) return true;
    if (!std.ascii.startsWithIgnoreCase(origin, "http://")) return false;
    const host_port = origin["http://".len..];
    const host = if (std.mem.lastIndexOfScalar(u8, host_port, ':')) |colon| host_port[0..colon] else host_port;
    return std.ascii.eqlIgnoreCase(host, "localhost") or std.mem.eql(u8, host, "127.0.0.1") or std.mem.eql(u8, host, "[::1]");
}

/// The decision itself, against an explicit configuration. Separated from the
/// cached environment lookup so it can be tested without a HOME directory.
fn decorateWith(allocator: std.mem.Allocator, url: []const u8, cfg: Resolved) Decoration {
    var out = Decoration{};

    // Requests written against the default registry follow the configured one.
    var effective = url;
    if (cfg.base) |base| {
        if (std.mem.startsWith(u8, url, default_base)) {
            const rewritten = std.fmt.allocPrint(allocator, "{s}{s}", .{ base, url[default_base.len..] }) catch return out;
            out.url = rewritten;
            effective = rewritten;
        }
    }

    const origin = originOf(effective) orelse return out;

    // The configured registry: env var, or credentials file, either scope.
    if (cfg.base_origin) |base_origin| {
        if (sameOrigin(origin, base_origin)) {
            if (cfg.base_token) |token| {
                out.authorization = std.fmt.allocPrint(allocator, "Bearer {s}", .{token}) catch null;
                return out;
            }
        }
    }

    // The public registry with a token set for this run: the environment wins
    // over the file, as it does everywhere else a token is resolved.
    if (cfg.default_from_env) {
        if (cfg.default_token) |token| {
            if (originOf(default_base)) |default_origin| {
                if (sameOrigin(origin, default_origin)) {
                    out.authorization = std.fmt.allocPrint(allocator, "Bearer {s}", .{token}) catch null;
                    return out;
                }
            }
        }
    }

    // Any origin the user has stored a scoped credential for.
    for (cfg.scoped) |entry| {
        if (sameOrigin(origin, entry.origin)) {
            out.authorization = std.fmt.allocPrint(allocator, "Bearer {s}", .{entry.token}) catch null;
            return out;
        }
    }

    // A registry the project pinned a scope to.
    for (cfg.pinned) |entry| {
        if (sameOrigin(origin, entry.origin)) {
            out.authorization = std.fmt.allocPrint(allocator, "Bearer {s}", .{entry.token}) catch null;
            return out;
        }
    }

    // The public registry, when this machine has a pantry token at all. The
    // token was issued by that registry, so this is the one host it belongs on;
    // it is what identifies the account that bought a paid package.
    if (cfg.default_token) |token| {
        if (originOf(default_base)) |default_origin| {
            if (sameOrigin(origin, default_origin))
                out.authorization = std.fmt.allocPrint(allocator, "Bearer {s}", .{token}) catch null;
        }
    }

    return out;
}

/// Point `io_helper` at this module. Called once from `main`.
pub fn install() void {
    io_helper.decorate_request = &decorate;
}

/// Drop the cache. Tests only — the CLI resolves once and exits.
pub fn resetForTesting() void {
    resolve_mutex.lock();
    defer resolve_mutex.unlock();
    resolved = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test "originOf keeps scheme, host and port, and stops at the path" {
    try std.testing.expectEqualStrings("https://registry.example.com", originOf("https://registry.example.com/packages/x").?);
    try std.testing.expectEqualStrings("https://registry.example.com:8443", originOf("https://registry.example.com:8443/a/b").?);
    try std.testing.expectEqualStrings("http://localhost:3000", originOf("http://localhost:3000").?);
    try std.testing.expect(originOf("not-a-url") == null);
}

test "an unconfigured client sends every request exactly as written" {
    const alloc = std.testing.allocator;
    const cfg = Resolved{};

    // The public registry, npm, GitHub — all untouched, no token anywhere.
    for ([_][]const u8{
        default_base ++ "/binaries/curl.se/metadata.json",
        "https://registry.npmjs.org/left-pad",
        "https://github.com/x/y/releases/download/v1/z.tar.gz",
    }) |url| {
        const dec = decorateWith(alloc, url, cfg);
        defer dec.deinit(alloc);
        try std.testing.expect(dec.isEmpty());
        try std.testing.expectEqualStrings(url, dec.effectiveUrl(url));
    }
}

test "a configured registry receives rewritten, authenticated requests" {
    const alloc = std.testing.allocator;
    const cfg = Resolved{
        .base = "https://registry.example.com",
        .base_origin = "https://registry.example.com",
        .base_token = "ptry_secret",
    };

    const dec = decorateWith(alloc, default_base ++ "/binaries/curl.se/metadata.json", cfg);
    defer dec.deinit(alloc);
    try std.testing.expectEqualStrings("https://registry.example.com/binaries/curl.se/metadata.json", dec.url.?);
    try std.testing.expectEqualStrings("Bearer ptry_secret", dec.authorization.?);
}

test "a token set for the run outranks one stored for the public registry" {
    const alloc = std.testing.allocator;
    const stored = [_]Scoped{.{ .origin = "https://registry.pantry.dev", .token = "ptry_personal" }};
    const from_env = Resolved{ .scoped = &stored, .default_token = "ptry_client_ci", .default_from_env = true };
    const env = decorateWith(alloc, default_base ++ "/packages/@hq%2Fplatform/versions", from_env);
    defer env.deinit(alloc);
    try std.testing.expectEqualStrings("Bearer ptry_client_ci", env.authorization.?);

    // Without one, the stored credential for that registry is used.
    const from_file = Resolved{ .scoped = &stored, .default_token = "ptry_personal" };
    const file = decorateWith(alloc, default_base ++ "/packages/@hq%2Fplatform/versions", from_file);
    defer file.deinit(alloc);
    try std.testing.expectEqualStrings("Bearer ptry_personal", file.authorization.?);

    // ...and the run's token still never leaves its registry.
    const npm = decorateWith(alloc, "https://registry.npmjs.org/left-pad", from_env);
    defer npm.deinit(alloc);
    try std.testing.expect(npm.authorization == null);
}

test "the public registry gets the credential it issued" {
    const alloc = std.testing.allocator;
    const cfg = Resolved{ .default_token = "ptry_account" };

    // A paid package is served against an account, so the token has to travel.
    const mine = decorateWith(alloc, default_base ++ "/packages/paid-lib/1.0.0/tarball", cfg);
    defer mine.deinit(alloc);
    try std.testing.expectEqualStrings("Bearer ptry_account", mine.authorization.?);

    // ...but only there.
    for ([_][]const u8{
        "https://registry.npmjs.org/left-pad",
        "https://bucket.fsn1.your-objectstorage.com/binaries/x.tar.gz",
        "https://registry.pantry.dev.attacker.test/packages/x",
    }) |url| {
        const dec = decorateWith(alloc, url, cfg);
        defer dec.deinit(alloc);
        try std.testing.expect(dec.authorization == null);
    }
}

test "the token never leaves the registry it belongs to" {
    const alloc = std.testing.allocator;
    const cfg = Resolved{
        .base = "https://registry.example.com",
        .base_origin = "https://registry.example.com",
        .base_token = "ptry_secret",
    };

    // Presigned object-storage redirects, npm, and lookalike hostnames are all
    // third parties as far as the credential is concerned.
    for ([_][]const u8{
        "https://bucket.fsn1.your-objectstorage.com/binaries/curl.se/x.tar.gz",
        "https://registry.npmjs.org/left-pad",
        "https://registry.example.com.attacker.test/binaries/x",
    }) |url| {
        const dec = decorateWith(alloc, url, cfg);
        defer dec.deinit(alloc);
        try std.testing.expect(dec.authorization == null);
    }
}

test "a scoped credential authenticates its own registry only" {
    const alloc = std.testing.allocator;
    const scoped = [_]Scoped{.{ .origin = "https://packages.acme.internal", .token = "ptry_acme" }};
    const cfg = Resolved{ .scoped = &scoped };

    const mine = decorateWith(alloc, "https://packages.acme.internal/packages/sdk/1.0.0/tarball", cfg);
    defer mine.deinit(alloc);
    try std.testing.expectEqualStrings("Bearer ptry_acme", mine.authorization.?);
    // No PANTRY_REGISTRY_URL, so nothing is rewritten.
    try std.testing.expect(mine.url == null);

    const theirs = decorateWith(alloc, default_base ++ "/packages/left-pad", cfg);
    defer theirs.deinit(alloc);
    try std.testing.expect(theirs.isEmpty());
}

test "port and case differences are part of the origin, not ignored" {
    const alloc = std.testing.allocator;
    const cfg = Resolved{
        .base = "http://localhost:3000",
        .base_origin = "http://localhost:3000",
        .base_token = "ptry_local",
    };

    const same = decorateWith(alloc, "http://LOCALHOST:3000/health", cfg);
    defer same.deinit(alloc);
    try std.testing.expectEqualStrings("Bearer ptry_local", same.authorization.?);

    const other_port = decorateWith(alloc, "http://localhost:3001/health", cfg);
    defer other_port.deinit(alloc);
    try std.testing.expect(other_port.authorization == null);
}

test "a registry pinned by scopes receives its credential, and nobody else does" {
    const alloc = std.testing.allocator;
    const pinned = [_]Scoped{.{ .origin = "https://registry.acme.test", .token = "ptry_client_ci" }};
    const cfg = Resolved{ .pinned = &pinned, .default_token = "ptry_account" };

    const versions = decorateWith(alloc, "https://registry.acme.test/packages/@acme%2Fsdk/versions", cfg);
    defer versions.deinit(alloc);
    try std.testing.expectEqualStrings("Bearer ptry_client_ci", versions.authorization.?);

    const tarball = decorateWith(alloc, "https://registry.acme.test/packages/@acme%2Fsdk/1.0.0/tarball", cfg);
    defer tarball.deinit(alloc);
    try std.testing.expectEqualStrings("Bearer ptry_client_ci", tarball.authorization.?);

    // The public registry keeps its own token; third parties get none.
    const public = decorateWith(alloc, default_base ++ "/packages/x", cfg);
    defer public.deinit(alloc);
    try std.testing.expectEqualStrings("Bearer ptry_account", public.authorization.?);
    for ([_][]const u8{
        "https://registry.npmjs.org/@acme/sdk",
        "https://registry.acme.test.attacker.test/packages/x",
        "http://registry.acme.test/packages/x",
    }) |url| {
        const dec = decorateWith(alloc, url, cfg);
        defer dec.deinit(alloc);
        try std.testing.expect(dec.authorization == null);
    }
}

test "tokens only travel over https, or plain http to this machine" {
    try std.testing.expect(secureEnoughForToken("https://registry.example.com"));
    try std.testing.expect(secureEnoughForToken("http://localhost:3000"));
    try std.testing.expect(secureEnoughForToken("http://127.0.0.1:3000"));
    try std.testing.expect(!secureEnoughForToken("http://registry.example.com"));
    try std.testing.expect(!secureEnoughForToken("http://localhost.attacker.test"));
    try std.testing.expect(!secureEnoughForToken("ftp://registry.example.com"));
}
