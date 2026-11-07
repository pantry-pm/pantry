//! Parallel Install Pipeline
//!
//! 3-phase pipeline that separates dependency resolution, tarball downloading,
//! and extraction into distinct parallel phases for maximum throughput.
//!
//! Phase 1: Resolve full dependency tree from npm registry metadata (no downloads)
//! Phase 2: Download all tarballs in parallel
//! Phase 3: Extract all packages + create bin shims

const std = @import("std");
const native_identity = @import("../packages/native_identity.zig");
const builtin = @import("builtin");
const io_helper = @import("../io_helper.zig");
const installer_mod = @import("installer.zig");
const cache_mod = @import("../cache.zig");
const packages = @import("../packages.zig");
const generated = @import("../packages/generated.zig");
const style = @import("../cli/style.zig");
const offline = @import("offline.zig");
const patches_mod = @import("patches.zig");
const downloader = @import("downloader.zig");
const scopes = @import("../registry/scopes.zig");

const Installer = installer_mod.Installer;
const PackageCache = cache_mod.PackageCache;
const PackageSpec = packages.PackageSpec;

/// Verify a downloaded tarball's bytes against an `integrity` string, which
/// may be either:
///   * an npm-style SRI value like "sha512-BASE64..." / "sha256-BASE64..."
///   * a raw lowercase hex SHA256 (64 chars)
///
/// Unknown, malformed, or unsupported formats fail closed. Callers only invoke
/// this function when the registry supplied an integrity value, so treating an
/// uncheckable claim as valid would silently bypass the package contract.
pub fn verifyIntegrity(allocator: std.mem.Allocator, bytes: []const u8, integrity_in: []const u8) bool {
    // `sha256:<hex>` - how the Pantry registry states a checksum, and what
    // pantry.lock records for a Pantry package - is the raw hex form below.
    const integrity = if (std.mem.startsWith(u8, integrity_in, "sha256:") and integrity_in.len == 7 + 64)
        integrity_in[7..]
    else
        integrity_in;

    // Raw hex SHA256
    if (integrity.len == 64) {
        var is_hex = true;
        for (integrity) |c| {
            if (!((c >= '0' and c <= '9') or (c >= 'a' and c <= 'f') or (c >= 'A' and c <= 'F'))) {
                is_hex = false;
                break;
            }
        }
        if (is_hex) {
            var digest: [32]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
            const hex = std.fmt.bytesToHex(digest, .lower);
            // Case-insensitive compare
            for (hex, 0..) |h, i| {
                const g = integrity[i];
                const lower_g: u8 = if (g >= 'A' and g <= 'Z') g + ('a' - 'A') else g;
                if (h != lower_g) return false;
            }
            return true;
        }
    }

    // SRI form: "<algo>-<base64>"
    const dash = std.mem.indexOfScalar(u8, integrity, '-') orelse return false;
    const algo = integrity[0..dash];
    const b64 = integrity[dash + 1 ..];

    if (std.mem.eql(u8, algo, "sha256")) {
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
        var expected: [32]u8 = undefined;
        const decoded = std.base64.standard.Decoder.calcSizeForSlice(b64) catch return false;
        if (decoded != 32) return false;
        std.base64.standard.Decoder.decode(&expected, b64) catch return false;
        return std.mem.eql(u8, &digest, &expected);
    } else if (std.mem.eql(u8, algo, "sha512")) {
        var digest: [64]u8 = undefined;
        std.crypto.hash.sha2.Sha512.hash(bytes, &digest, .{});
        var expected: [64]u8 = undefined;
        const decoded = std.base64.standard.Decoder.calcSizeForSlice(b64) catch return false;
        if (decoded != 64) return false;
        std.base64.standard.Decoder.decode(&expected, b64) catch return false;
        return std.mem.eql(u8, &digest, &expected);
    } else if (std.mem.eql(u8, algo, "sha1")) {
        // sha1 still shows up on npm; verify for completeness
        var digest: [20]u8 = undefined;
        std.crypto.hash.Sha1.hash(bytes, &digest, .{});
        var expected: [20]u8 = undefined;
        const decoded = std.base64.standard.Decoder.calcSizeForSlice(b64) catch return false;
        if (decoded != 20) return false;
        std.base64.standard.Decoder.decode(&expected, b64) catch return false;
        return std.mem.eql(u8, &digest, &expected);
    }

    _ = allocator;
    return false;
}

test "parsePantryDepSpec and parseForeignOsDepSpec partition every spec" {
    // A spec is for this host, or for another one, or unusable. The two parsers
    // must never both claim one, and between them must not lose a usable spec.
    const this_os = switch (builtin.os.tag) {
        .linux => "linux",
        .macos => "darwin",
        .windows => "windows",
        else => "",
    };
    const other_os = if (std.mem.eql(u8, this_os, "linux")) "darwin" else "linux";

    var native_buf: [64]u8 = undefined;
    const native = try std.fmt.bufPrint(&native_buf, "{s}:gnu.org/gcc/libstdcxx^14", .{this_os});
    var foreign_buf: [64]u8 = undefined;
    const foreign = try std.fmt.bufPrint(&foreign_buf, "{s}:gnu.org/gcc/libstdcxx^14", .{other_os});

    // Guarded for this host: installable, not foreign.
    try std.testing.expect(parsePantryDepSpec(native) != null);
    try std.testing.expect(parseForeignOsDepSpec(native) == null);

    // Guarded for another host: foreign, not installable.
    try std.testing.expect(parsePantryDepSpec(foreign) == null);
    const parsed_foreign = parseForeignOsDepSpec(foreign) orelse return error.TestExpectedForeign;
    try std.testing.expectEqualStrings("gnu.org/gcc/libstdcxx", parsed_foreign.domain);
    try std.testing.expectEqualStrings("^14", parsed_foreign.version);

    // Unguarded: installable everywhere, and never foreign.
    try std.testing.expect(parsePantryDepSpec("openssl.org^3") != null);
    try std.testing.expect(parseForeignOsDepSpec("openssl.org^3") == null);
}

test "parseForeignOsDepSpec keeps the comment and version handling of the native parser" {
    const other_os = if (builtin.os.tag == .linux) "darwin" else "linux";

    var buf: [96]u8 = undefined;
    const spec = try std.fmt.bufPrint(&buf, "{s}:gnu.org/gcc/libstdcxx@15 # since 20250814.0", .{other_os});
    const parsed = parseForeignOsDepSpec(spec) orelse return error.TestExpectedForeign;

    try std.testing.expectEqualStrings("gnu.org/gcc/libstdcxx", parsed.domain);
    try std.testing.expectEqualStrings("15", parsed.version);
}

test "platformDependentClosure is symmetric, and reaches a pin only through its declarer" {
    // Two properties, both learned the hard way (pantry-pm/pantry#232).
    //
    // SYMMETRY. An OS guard on a version constraint makes a package resolve
    // differently per platform, in BOTH directions. The first version of this
    // asked "is the guard for an OS I am not", which is right on the host the
    // guard excludes and wrong on the host it names: `git-scm.org` declares
    // `linux:gnu.org/gettext^0.21`, so on macOS gettext looks foreign and is
    // kept, while on Linux it looks perfectly native and the macOS pin is swept
    // as a stale duplicate. A macOS install then dropped one record and a Linux
    // install dropped the other. Asking "is it guarded at all" is the same
    // question on both.
    //
    // LEAF-NESS. A guarded pin does not declare its own guard - the package
    // that declares it is one the host resolves natively - so a closure seeded
    // only from the pins finds nothing, and every one of them then looks stale.
    //
    // The pair is discovered from the catalog rather than hard-coded, so this
    // asserts the same thing on every platform.
    const allocator = std.testing.allocator;

    var declaring: ?[]const u8 = null;
    var pin: ?[]const u8 = null;
    outer: for (generated.packages) |info| {
        for (info.dependencies) |spec| {
            if (parseOsGuardedDepSpec(spec)) |guarded| {
                declaring = info.domain;
                pin = guarded.domain;
                break :outer;
            }
        }
    }
    const declaring_domain = declaring orelse return error.SkipZigTest;
    const pin_domain = pin.?;

    // Reached from the package that declares the guard.
    var from_declaring = try platformDependentClosure(allocator, &.{declaring_domain});
    defer from_declaring.deinit();
    try std.testing.expect(from_declaring.contains(pin_domain));

    // Not reached from the pin itself, because a package does not declare
    // itself. That asymmetry is why the caller has to seed from what it just
    // resolved as well as from what the lockfile already holds.
    var from_pin = try platformDependentClosure(allocator, &.{pin_domain});
    defer from_pin.deinit();
    try std.testing.expect(!from_pin.contains(pin_domain));
}

test "platformDependentClosure answers the same on either side of a guard" {
    // The symmetry above, asserted without needing to run on two machines: a
    // guard is native on one host and foreign on the other, and this must reach
    // the domain in both cases. `parseForeignOsDepSpec` agrees with
    // `parseOsGuardedDepSpec` on exactly one of the two, which is the bug.
    const native_prefix = switch (builtin.os.tag) {
        .linux => "linux",
        .macos => "darwin",
        .windows => "windows",
        else => return error.SkipZigTest,
    };
    const foreign_prefix = if (std.mem.eql(u8, native_prefix, "linux")) "darwin" else "linux";

    var native_buf: [64]u8 = undefined;
    const native = try std.fmt.bufPrint(&native_buf, "{s}:gnu.org/gettext^0.21", .{native_prefix});
    var foreign_buf: [64]u8 = undefined;
    const foreign = try std.fmt.bufPrint(&foreign_buf, "{s}:gnu.org/gettext^0.21", .{foreign_prefix});

    // Guarded either way, so platform-dependent either way.
    try std.testing.expectEqualStrings("gnu.org/gettext", parseOsGuardedDepSpec(native).?.domain);
    try std.testing.expectEqualStrings("gnu.org/gettext", parseOsGuardedDepSpec(foreign).?.domain);

    // Where the old question disagreed with itself.
    try std.testing.expect(parseForeignOsDepSpec(native) == null);
    try std.testing.expect(parseForeignOsDepSpec(foreign) != null);

    // And an unguarded spec is not platform-dependent at all.
    try std.testing.expect(parseOsGuardedDepSpec("gnu.org/gettext") == null);
    try std.testing.expect(parseOsGuardedDepSpec("openssl.org^3") == null);
}
test "parseForeignOsDepSpec rejects what nobody can use" {
    // Malformed is not the same as foreign. A caller asking "which pins does
    // this host legitimately not know about" must not be handed junk.
    try std.testing.expect(parseForeignOsDepSpec("") == null);
    try std.testing.expect(parseForeignOsDepSpec("   ") == null);
    try std.testing.expect(parseForeignOsDepSpec("# just a comment") == null);
    try std.testing.expect(parseForeignOsDepSpec("linux/x86-64") == null);
    // A colon that is not an OS guard is a domain, and belongs to this host.
    try std.testing.expect(parseForeignOsDepSpec("example.com:8080/pkg") == null);
}

test "verifyIntegrity sha256 hex happy path" {
    const allocator = std.testing.allocator;
    const body = "hello world";
    // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    const hex = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    try std.testing.expect(verifyIntegrity(allocator, body, hex));
    const bad = "0000000000000000000000000000000000000000000000000000000000000000";
    try std.testing.expect(!verifyIntegrity(allocator, body, bad));
}

test "verifyIntegrity sha256:<hex> as the Pantry registry states it" {
    const allocator = std.testing.allocator;
    try std.testing.expect(verifyIntegrity(allocator, "hello world", "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"));
    try std.testing.expect(!verifyIntegrity(allocator, "hello World", "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"));
    try std.testing.expect(!verifyIntegrity(allocator, "hello world", "sha256:b94d27"));
}

test "verifyIntegrity rejects unknown and malformed claims" {
    const allocator = std.testing.allocator;
    try std.testing.expect(!verifyIntegrity(allocator, "x", "frobnitz-abc"));
    try std.testing.expect(!verifyIntegrity(allocator, "x", "missing-separator"[0..7]));
    try std.testing.expect(!verifyIntegrity(allocator, "x", "sha256-not-base64!"));
}

test "verifyIntegrity sha512 SRI happy path" {
    const allocator = std.testing.allocator;
    const body = "hello world";
    // node -e 'console.log("sha512-" + require("crypto").createHash("sha512").update("hello world").digest("base64"))'
    const sri = "sha512-MJ7MSJwS1utMxA9QyQLytNDtd+5RGnx6m808qG1M2G+YndNbxf9JlnDaNCVbRbDP2DDoH2Bdz33FVC6TrpzXbw==";
    try std.testing.expect(verifyIntegrity(allocator, body, sri));
}

test "verifyIntegrity sha1 SRI" {
    const allocator = std.testing.allocator;
    // sha1("hello world") = 2aae6c35c94fcfb415dbe95f408b9ce91ee846ed
    const body = "hello world";
    const sri = "sha1-Kq5sNclPz7QV2+lfQIuc6R7oRu0=";
    try std.testing.expect(verifyIntegrity(allocator, body, sri));
}

test "verifyIntegrity detects tampered body under sha256 hex" {
    const allocator = std.testing.allocator;
    const original = "hello world";
    const tampered = "hello World"; // capital W
    // sha256("hello world") hex
    const hex = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    try std.testing.expect(verifyIntegrity(allocator, original, hex));
    try std.testing.expect(!verifyIntegrity(allocator, tampered, hex));
}

// ============================================================================
// Public Types
// ============================================================================

pub const ResolvedPackage = struct {
    name: []const u8,
    version: []const u8,
    tarball_url: []const u8,
    integrity: ?[]const u8,
    source: packages.PackageSource,
    github_owner: ?[]const u8 = null,
    github_repo: ?[]const u8 = null,
    /// Reached only through `optionalDependencies`: a failure to install it
    /// does not fail the install.
    optional: bool = false,
    /// A platform package for another machine (`@esbuild/linux-x64` on a
    /// Mac). Recorded in the lock, as bun.lock records every platform's, but
    /// not downloaded.
    lock_only: bool = false,
    /// In a scope the project pinned to a Pantry registry (see
    /// registry/scopes.zig). Its integrity is recorded in the lock even when
    /// the registry sent none.
    pinned: bool = false,
    /// Resolution failed and nothing else may be tried: reported as this
    /// package's install error instead of downloading anything. Owned.
    resolve_error: ?[]const u8 = null,
};

/// Free everything a `ResolvedPackage` owns.
pub fn freeResolved(allocator: std.mem.Allocator, pkg: ResolvedPackage) void {
    allocator.free(pkg.name);
    allocator.free(pkg.version);
    allocator.free(pkg.tarball_url);
    if (pkg.integrity) |i| allocator.free(i);
    if (pkg.resolve_error) |e| allocator.free(e);
}

pub const PackageResult = struct {
    /// Actual resolved provider. Null supports older manually authored callers.
    source: ?packages.PackageSource = null,
    name: []const u8,
    version: []const u8,
    success: bool,
    error_msg: ?[]const u8 = null,
    from_cache: bool = false,
    policy_failure: bool = false,
    /// See `ResolvedPackage.lock_only`: belongs in the lock, not on disk, and
    /// is not reported as installed.
    lock_only: bool = false,
    /// The tarball's integrity, for the lockfile. Set for packages from a
    /// pinned Pantry scope (registry checksum, else sha256 of the bytes).
    /// Owned.
    integrity: ?[]const u8 = null,
};

pub const PipelineResult = struct {
    installed_count: usize,
    cached_count: usize,
    failed_count: usize,
    results: []PackageResult,

    pub fn deinit(self: *PipelineResult, allocator: std.mem.Allocator) void {
        for (self.results) |*r| {
            if (r.error_msg) |msg| allocator.free(msg);
            if (r.integrity) |i| allocator.free(i);
            if (r.name.len > 0) allocator.free(r.name);
            if (r.version.len > 0) allocator.free(r.version);
        }
        allocator.free(self.results);
    }
};

/// Input dependency for the pipeline
pub const PipelineDep = struct {
    name: []const u8,
    version: []const u8,
    /// Authored range survives a provisional generic/npm lock preference.
    declared_constraint: ?[]const u8 = null,
    source: packages.PackageSource,
    github_owner: ?[]const u8 = null,
    github_repo: ?[]const u8 = null,
    /// Reached through an `optionalDependencies` entry.
    optional: bool = false,
    /// Only an original auto-registry declaration may discover native fallback.
    allow_pantry_fallback: bool = false,
};

fn canUseNpmFastPath(top_level_count: usize, npm_count: usize, missing_npm_count: usize) bool {
    return missing_npm_count == 0 and npm_count > 0 and npm_count == top_level_count;
}

test "npm fast path does not skip mixed-source dependencies" {
    try std.testing.expect(canUseNpmFastPath(3, 3, 0));
    try std.testing.expect(!canUseNpmFastPath(4, 3, 0));
    try std.testing.expect(!canUseNpmFastPath(3, 3, 1));
}

// ============================================================================
// Phase 1: Full Tree Resolution
// ============================================================================

/// Thread context for parallel npm metadata resolution
const ResolveThreadCtx = struct {
    installer: *Installer,
    deps: []const PipelineDep,
    results: []?Installer.NpmResolutionWithDeps,
    /// Why a dependency in a pinned scope did not resolve (null otherwise).
    errors: []?anyerror,
    next: *std.atomic.Value(usize),
    verbose: bool,

    fn worker(ctx: *ResolveThreadCtx) void {
        while (true) {
            const i = ctx.next.fetchAdd(1, .monotonic);
            if (i >= ctx.deps.len) break;

            const dep = ctx.deps[i];

            // Skip non-npm packages in resolution phase. .pantry-source
            // (system) deps don't have npm metadata — they resolve via the
            // pantry S3 registry inside the download phase. Routing them
            // through resolveNpmPackageWithDeps would hit npmjs.org and find
            // squatter packages (e.g. `bun.sh@0.0.0`).
            //
            // A name in a pinned scope resolves through the installer whatever
            // source it was declared with: `resolveNpmPackageWithDeps` sends
            // it to its Pantry registry and nowhere else.
            const pinned = ctx.installer.pinFor(dep.name) != null;
            if (dep.source != .npm and !pinned) {
                ctx.results[i] = null;
                continue;
            }

            if (ctx.verbose) {
                std.debug.print("[verbose:pipeline:resolve] resolving: {s} @ {s}\n", .{ dep.name, dep.version });
            }

            ctx.results[i] = ctx.installer.resolveNpmPackageWithDepsWithPreference(dep.name, dep.version, npmPreferenceForDep(ctx.installer, dep)) catch |err| blk: {
                if (ctx.verbose) {
                    std.debug.print("[verbose:pipeline:resolve] FAILED: {s} @ {s}: {}\n", .{ dep.name, dep.version, err });
                }
                ctx.errors[i] = err;
                break :blk null;
            };
        }
    }
};

const native_deps = @import("native_deps.zig");
const parsePantryDepSpec = native_deps.parsePantryDepSpec;
pub const parseForeignOsDepSpec = native_deps.parseForeignOsDepSpec;
pub const parseOsGuardedDepSpec = native_deps.parseOsGuardedDepSpec;
pub const parseAnyOsDepSpec = native_deps.parseAnyOsDepSpec;
const parseDepSpecForPlatform = native_deps.parseDepSpecForPlatform;

/// Every package whose resolved version depends on which platform installs it.
///
/// Seeded from the OS-GUARDED dependencies of `seeds` - guarded for any OS,
/// not only for one this host is not - then walked through what those need in
/// turn, guarded or not, because a package that only exists on Linux does not
/// guard its own dependencies a second time. `linux:gnu.org/gcc/libstdcxx@14`
/// is a seed; gmp, mpfr, mpc and binutils arrive on the walk.
///
/// The symmetry is what makes a lock survive a round trip, and it is the part
/// that took two goes to get right. A guard for ANOTHER OS marks a package this
/// host cannot install, which is the obvious case. A guard for THIS one marks a
/// package this host resolves under a constraint the other host does not have,
/// which is the same problem seen from the other side: `git-scm.org` declares
/// `linux:gnu.org/gettext^0.21`, so Linux pins gettext 0.21.1 and macOS pins
/// 1.0.0, and a lock naming only one of them is a lock that cannot cross
/// (pantry-pm/pantry#232).
///
/// A domain nothing declares any more is in neither set, so an obsolete record
/// is still pruned - which is what keeps this from being "carry everything
/// forward".
///
/// The caller owns the returned map. Keys point into the static catalog, so
/// they outlive it and need no freeing.
pub fn platformDependentClosure(allocator: std.mem.Allocator, seeds: []const []const u8) !std.StringHashMap(void) {
    var wanted = std.StringHashMap(void).init(allocator);
    errdefer wanted.deinit();

    var frontier = std.ArrayList([]const u8).empty;
    defer frontier.deinit(allocator);

    for (seeds) |seed| {
        const domain = native_identity.canonical(seed);
        const info = generated.getPackageByDomain(domain) orelse continue;
        for (info.dependencies) |spec| {
            const guarded = parseOsGuardedDepSpec(spec) orelse continue;
            const child = native_identity.canonical(guarded.domain);
            if ((try wanted.getOrPut(child)).found_existing) continue;
            try frontier.append(allocator, child);
        }
    }

    while (frontier.pop()) |domain| {
        const info = generated.getPackageByDomain(domain) orelse continue;
        for (info.dependencies) |spec| {
            const parsed = parseAnyOsDepSpec(spec) orelse continue;
            const child = native_identity.canonical(parsed.domain);
            if ((try wanted.getOrPut(child)).found_existing) continue;
            try frontier.append(allocator, child);
        }
    }

    return wanted;
}

fn resolvePantryRegistryTarball(
    allocator: std.mem.Allocator,
    name: []const u8,
    version: []const u8,
) !?ResolvedPackage {
    if (try downloader.lookupS3Registry(allocator, name, version)) |s3_result| {
        return .{
            .name = allocator.dupe(u8, name) catch {
                allocator.free(s3_result.version);
                allocator.free(s3_result.tarball_url);
                return null;
            },
            .version = s3_result.version,
            .tarball_url = s3_result.tarball_url,
            .integrity = null,
            .source = .pantry,
        };
    }

    if (try downloader.lookupPantryPublished(allocator, name, version)) |pub_result| {
        return .{
            .name = allocator.dupe(u8, name) catch {
                allocator.free(pub_result.version);
                allocator.free(pub_result.tarball_url);
                return null;
            },
            .version = pub_result.version,
            .tarball_url = pub_result.tarball_url,
            .integrity = null,
            .source = .pantry,
        };
    }

    return null;
}

fn npmPreferenceForDep(installer: *const Installer, dep: PipelineDep) Installer.NpmLockPreference {
    return if (dep.source == .npm and dep.allow_pantry_fallback)
        .{ .npm = .{ .declared_constraint = nativeConstraint(dep), .force = installer.native_policy.force } }
    else
        .legacy;
}

fn nativeConstraint(dep: PipelineDep) []const u8 {
    return dep.declared_constraint orelse dep.version;
}

fn nativeFallbackRoot(allocator: std.mem.Allocator, native_plan: *native_deps.Plan, dep: PipelineDep) !bool {
    return nativeFallbackRootUsing(allocator, native_plan, dep, resolvePantryRegistryTarball);
}

fn nativeFallbackRootUsing(allocator: std.mem.Allocator, native_plan: *native_deps.Plan, dep: PipelineDep, comptime lookup: anytype) !bool {
    if (!dep.allow_pantry_fallback) return false;
    const declared = nativeConstraint(dep);
    const witness = lookup(allocator, native_identity.canonical(dep.name), declared) catch |err| {
        // Missing optional npm metadata is not native authority. Retain its
        // ordinary optional failure when the independent witness is unavailable.
        if (dep.optional and err != error.OutOfMemory and !native_deps.isPolicyError(err)) return false;
        return err;
    } orelse return false;
    defer freeResolved(allocator, witness);
    try native_plan.add(dep.name, declared);
    return true;
}

fn unresolvedNpm(allocator: std.mem.Allocator, dep: PipelineDep, err: anyerror) !ResolvedPackage {
    const name = try allocator.dupe(u8, dep.name);
    errdefer allocator.free(name);
    const version = try allocator.dupe(u8, dep.version);
    errdefer allocator.free(version);
    const url = try allocator.dupe(u8, "");
    errdefer allocator.free(url);
    return .{ .name = name, .version = version, .tarball_url = url, .integrity = null, .source = .npm, .optional = dep.optional, .resolve_error = try std.fmt.allocPrint(allocator, "{s}", .{@errorName(err)}) };
}

fn freeWaveDeps(allocator: std.mem.Allocator, deps: []const PipelineDep) void {
    for (deps) |dep| {
        allocator.free(dep.name);
        allocator.free(dep.version);
    }
}

fn appendOwnedWaveDep(allocator: std.mem.Allocator, wave: *std.ArrayList(PipelineDep), dep: PipelineDep) !void {
    const name = try allocator.dupe(u8, dep.name);
    errdefer allocator.free(name);
    const version = try allocator.dupe(u8, dep.version);
    errdefer allocator.free(version);
    var owned = dep;
    owned.name = name;
    owned.version = version;
    try wave.append(allocator, owned);
}

fn rememberResolvedName(allocator: std.mem.Allocator, seen: *std.StringHashMap(void), name: []const u8) !void {
    const owned = try allocator.dupe(u8, name);
    errdefer allocator.free(owned);
    try seen.put(owned, {});
}

fn requireNativeSourceCompatible(plan: *const native_deps.Plan, npm_name: []const u8) !void {
    if (plan.entries.contains(npm_name)) return error.NativeSourceConflict;
}

fn copyNpmResolution(allocator: std.mem.Allocator, name: []const u8, result: Installer.NpmResolutionWithDeps, optional: bool, pinned: bool) !ResolvedPackage {
    const owned_name = try allocator.dupe(u8, name);
    errdefer allocator.free(owned_name);
    const version = try allocator.dupe(u8, result.version);
    errdefer allocator.free(version);
    const url = try allocator.dupe(u8, result.tarball_url);
    errdefer allocator.free(url);
    return .{ .name = owned_name, .version = version, .tarball_url = url, .integrity = if (result.integrity) |integrity| try allocator.dupe(u8, integrity) else null, .source = .npm, .optional = optional, .pinned = pinned, .lock_only = !result.platform_ok };
}

fn resolveMetadataWave(ctx: *ResolveThreadCtx) !void {
    // Cap at 8 threads for metadata resolution. Higher values (12+) cause
    // connection hangs on macOS. 8 is the stable sweet spot.
    const cpu_count = std.Thread.getCpuCount() catch 4;
    const max_threads = @min(cpu_count, 8);
    const thread_count = @min(ctx.deps.len, max_threads);

    if (thread_count <= 1) {
        ResolveThreadCtx.worker(ctx);
    } else {
        const spawned = thread_count - 1;
        var threads = try ctx.installer.allocator.alloc(?std.Thread, spawned);
        defer ctx.installer.allocator.free(threads);
        for (threads) |*t| t.* = null;

        for (0..spawned) |t| {
            threads[t] = std.Thread.spawn(.{}, ResolveThreadCtx.worker, .{ctx}) catch null;
        }
        ResolveThreadCtx.worker(ctx);

        for (threads) |*t| {
            if (t.*) |thread| {
                thread.join();
                t.* = null;
            }
        }
    }
}

/// Resolve the full dependency tree from npm registry metadata.
/// Returns a flat deduplicated list of all packages to install.
fn resolveFullTree(
    allocator: std.mem.Allocator,
    inst: *Installer,
    top_level_deps: []const PipelineDep,
    verbose: bool,
    native_plan: *native_deps.Plan,
) !std.ArrayList(ResolvedPackage) {
    return resolveFullTreeUsing(allocator, inst, top_level_deps, verbose, native_plan, resolveMetadataWave);
}

fn resolveFullTreeUsing(
    allocator: std.mem.Allocator,
    inst: *Installer,
    top_level_deps: []const PipelineDep,
    verbose: bool,
    native_plan: *native_deps.Plan,
    comptime resolve_wave: anytype,
) !std.ArrayList(ResolvedPackage) {
    var resolved = std.ArrayList(ResolvedPackage).empty;
    errdefer {
        for (resolved.items) |pkg| {
            freeResolved(allocator, pkg);
        }
        resolved.deinit(allocator);
    }

    // Track resolved packages by name to deduplicate
    var seen = std.StringHashMap(void).init(allocator);
    defer {
        var keys = seen.keyIterator();
        while (keys.next()) |key| allocator.free(key.*);
        seen.deinit();
    }

    // BFS wave queue: starts with top-level deps
    var current_wave = std.ArrayList(PipelineDep).empty;
    var current_wave_owned = false;
    defer {
        if (current_wave_owned) freeWaveDeps(allocator, current_wave.items);
        current_wave.deinit(allocator);
    }

    // Seed with top-level deps
    for (top_level_deps) |dep| {
        try current_wave.append(allocator, dep);
    }

    var depth: u32 = 0;
    const max_depth: u32 = 30;

    while (current_wave.items.len > 0 and depth < max_depth) {
        const wave_size = current_wave.items.len;

        if (verbose) {
            std.debug.print("[verbose:pipeline:resolve] wave {d}: {d} deps to resolve\n", .{ depth, wave_size });
        }

        // Resolve this wave in parallel
        const results = try allocator.alloc(?Installer.NpmResolutionWithDeps, wave_size);
        for (results) |*r| r.* = null;
        defer {
            for (results) |*pending| if (pending.*) |*result| result.deinit(allocator);
            allocator.free(results);
        }
        const resolve_errors = try allocator.alloc(?anyerror, wave_size);
        defer allocator.free(resolve_errors);
        for (resolve_errors) |*e| e.* = null;

        var next_idx = std.atomic.Value(usize).init(0);
        var ctx = ResolveThreadCtx{
            .installer = inst,
            .deps = current_wave.items,
            .results = results,
            .errors = resolve_errors,
            .next = &next_idx,
            .verbose = verbose,
        };

        try resolve_wave(&ctx);

        // Collect results and build next wave from transitive deps
        var next_wave = std.ArrayList(PipelineDep).empty;
        defer {
            freeWaveDeps(allocator, next_wave.items);
            next_wave.deinit(allocator);
        }

        for (results, 0..) |maybe_result, ri| {
            if (maybe_result) |res| {
                var result = res;
                results[ri] = null;
                defer result.deinit(allocator);
                try requireNativeSourceCompatible(native_plan, current_wave.items[ri].name);
                const name_key = current_wave.items[ri].name;
                if (!seen.contains(name_key)) {
                    try rememberResolvedName(allocator, &seen, name_key);
                    const owned = try copyNpmResolution(allocator, name_key, result, current_wave.items[ri].optional, inst.pinFor(name_key) != null);
                    resolved.append(allocator, owned) catch |err| {
                        freeResolved(allocator, owned);
                        return err;
                    };
                    if (result.platform_ok) inst.hoisted_versions.put(name_key, result.version);
                }

                for (result.dependencies) |dep| {
                    if (!result.platform_ok or seen.contains(dep.name)) continue;
                    if (inst.hoisted_versions.checkSatisfies(dep.name, dep.version_constraint)) continue;
                    try appendOwnedWaveDep(allocator, &next_wave, .{ .name = dep.name, .version = dep.version_constraint, .source = .npm, .optional = dep.is_optional });
                }
            } else {
                // Resolution returned no result — add non-npm packages
                // directly with their original source preserved. .pantry,
                // .github, .git, .http, .ziglang, .local all install via
                // their own paths in the download phase (or out-of-band).
                const dep = current_wave.items[ri];
                if (inst.pinFor(dep.name) != null) {
                    // A pinned scope that did not resolve is an install error.
                    // No Pantry binary lookup, no npm: nothing else is tried.
                    if (!seen.contains(dep.name)) {
                        try rememberResolvedName(allocator, &seen, dep.name);
                        const err = resolve_errors[ri] orelse error.PinnedUnavailable;
                        const message = inst.describePinnedFailure(allocator, err, dep.name, dep.version) orelse
                            try std.fmt.allocPrint(allocator, "{s}", .{@errorName(err)});
                        errdefer allocator.free(message);
                        const name = try allocator.dupe(u8, dep.name);
                        errdefer allocator.free(name);
                        const version = try allocator.dupe(u8, dep.version);
                        errdefer allocator.free(version);
                        try resolved.append(allocator, .{
                            .name = name,
                            .version = version,
                            .tarball_url = try allocator.dupe(u8, ""),
                            .integrity = null,
                            .source = .npm,
                            .optional = dep.optional,
                            .pinned = true,
                            .resolve_error = message,
                        });
                    }
                } else if (dep.source == .npm) {
                    if (try nativeFallbackRoot(allocator, native_plan, dep)) {
                        if (!seen.contains(dep.name)) {
                            try rememberResolvedName(allocator, &seen, dep.name);
                            try resolved.append(allocator, .{
                                .name = try allocator.dupe(u8, dep.name),
                                .version = try allocator.dupe(u8, dep.version),
                                .tarball_url = try allocator.dupe(u8, ""),
                                .integrity = null,
                                .source = .pantry,
                            });
                        }
                    } else if (!seen.contains(dep.name)) {
                        try rememberResolvedName(allocator, &seen, dep.name);
                        try resolved.append(allocator, try unresolvedNpm(allocator, dep, resolve_errors[ri] orelse error.NpmRegistryUnavailable));
                    }
                } else {
                    if (dep.source == .pantry) try native_plan.add(dep.name, nativeConstraint(dep));
                    if (!seen.contains(dep.name)) {
                        try rememberResolvedName(allocator, &seen, dep.name);
                        if (dep.source == .pantry) {
                            try resolved.append(allocator, .{
                                .name = try allocator.dupe(u8, dep.name),
                                .version = try allocator.dupe(u8, dep.version),
                                .tarball_url = try allocator.dupe(u8, ""),
                                .integrity = null,
                                .source = dep.source,
                            });
                        } else {
                            try resolved.append(allocator, .{
                                .name = try allocator.dupe(u8, dep.name),
                                .version = try allocator.dupe(u8, dep.version),
                                .tarball_url = try allocator.dupe(u8, ""),
                                .integrity = null,
                                .source = dep.source,
                                .github_owner = dep.github_owner,
                                .github_repo = dep.github_repo,
                            });
                        }
                    }
                }
            }
        }

        if (current_wave_owned) freeWaveDeps(allocator, current_wave.items);
        current_wave.clearRetainingCapacity();
        current_wave_owned = true;

        var next_seen = std.StringHashMap(void).init(allocator);
        defer next_seen.deinit();
        for (next_wave.items) |dep| {
            if (next_seen.contains(dep.name) or seen.contains(dep.name)) continue;
            try next_seen.put(dep.name, {});
            try appendOwnedWaveDep(allocator, &current_wave, dep);
        }
        depth += 1;
    }

    if (verbose) {
        std.debug.print("[verbose:pipeline:resolve] tree resolved: {d} unique packages in {d} waves\n", .{ resolved.items.len, depth });
    }

    return resolved;
}

// ============================================================================
// Phase 2: Parallel Download
// ============================================================================

const DownloadThreadCtx = struct {
    installer: *Installer,
    packages: []const ResolvedPackage,
    results: []PackageResult,
    project_root: []const u8,
    modules_dir: []const u8,
    next: *std.atomic.Value(usize),
    completed: *std.atomic.Value(usize),
    verbose: bool,
    show_progress: bool,
    native_plan: *const native_deps.Plan,

    fn worker(ctx: *DownloadThreadCtx) void {
        const alloc = ctx.installer.allocator;
        while (true) {
            const i = ctx.next.fetchAdd(1, .monotonic);
            if (i >= ctx.packages.len) break;

            // Bump the finished-package count on every exit from this iteration
            // — success, failure, or any early `continue` in the body — so the
            // live progress line advances exactly once per package. The inner
            // download-retry loop's `continue` targets that loop, not this one,
            // so it never trips this defer early.
            defer _ = ctx.completed.fetchAdd(1, .release);

            const pkg = ctx.packages[i];
            defer ctx.results[i].source = pkg.source;
            // Dupe name+version so results outlive the resolved list
            const owned_name = alloc.dupe(u8, pkg.name) catch "";
            const owned_version = alloc.dupe(u8, pkg.version) catch "";

            if (pkg.lock_only) {
                ctx.results[i] = .{ .name = owned_name, .version = owned_version, .success = true, .from_cache = true, .lock_only = true };
                continue;
            }

            if (pkg.resolve_error) |message| {
                ctx.results[i] = .{ .name = owned_name, .version = owned_version, .success = false, .error_msg = alloc.dupe(u8, message) catch null };
                continue;
            }

            // .pantry source: system binaries from registry.pantry.dev.
            // Delegate to installer.install() which handles S3 lookup,
            // version resolution, download, and extraction for system deps.
            if (pkg.source == .pantry) {
                const spec = PackageSpec{
                    .name = pkg.name,
                    .version = pkg.version,
                    .source = .pantry,
                };
                const opts = installer_mod.InstallOptions{
                    .verbose = ctx.verbose,
                    .project_root = ctx.project_root,
                    // Silence the installer's own per-package download/extract
                    // lines while the live spinner owns the terminal line.
                    .quiet = ctx.show_progress,
                    .native_plan = ctx.native_plan,
                    .force = ctx.installer.native_policy.force,
                };
                if (ctx.installer.install(spec, opts)) |install_result_| {
                    var ir = install_result_;
                    defer ir.deinit(alloc);
                    ctx.results[i] = .{
                        .name = owned_name,
                        .version = alloc.dupe(u8, ir.version) catch owned_version,
                        .success = true,
                        .from_cache = ir.from_cache,
                    };
                    if (ctx.verbose) {
                        std.debug.print("[verbose:pipeline:download] pantry-source installed: {s} @ {s}\n", .{ pkg.name, ir.version });
                    }
                } else |err| {
                    const msg = std.fmt.allocPrint(alloc, "{s}", .{@errorName(err)}) catch null;
                    ctx.results[i] = .{
                        .name = owned_name,
                        .version = owned_version,
                        .success = false,
                        .error_msg = msg,
                        .policy_failure = native_deps.isPolicyError(err),
                    };
                    if (ctx.verbose) {
                        std.debug.print("[verbose:pipeline:download] pantry-source FAILED: {s} @ {s}: {s}\n", .{ pkg.name, pkg.version, @errorName(err) });
                    }
                }
                continue;
            }

            if (pkg.source == .github) {
                const owner = pkg.github_owner orelse {
                    ctx.results[i] = .{ .name = owned_name, .version = owned_version, .success = false, .error_msg = alloc.dupe(u8, "missing GitHub owner") catch null };
                    continue;
                };
                const repo_name = pkg.github_repo orelse {
                    ctx.results[i] = .{ .name = owned_name, .version = owned_version, .success = false, .error_msg = alloc.dupe(u8, "missing GitHub repository") catch null };
                    continue;
                };
                var repo_buf: [512]u8 = undefined;
                const repo = std.fmt.bufPrint(&repo_buf, "{s}/{s}", .{ owner, repo_name }) catch {
                    ctx.results[i] = .{ .name = owned_name, .version = owned_version, .success = false, .error_msg = alloc.dupe(u8, "GitHub repository name is too long") catch null };
                    continue;
                };
                const spec = PackageSpec{
                    .name = pkg.name,
                    .version = pkg.version,
                    .source = .github,
                    .repo = repo,
                };
                const opts = installer_mod.InstallOptions{
                    .verbose = ctx.verbose,
                    .project_root = ctx.project_root,
                    .quiet = ctx.show_progress,
                };
                if (ctx.installer.install(spec, opts)) |install_result_| {
                    var ir = install_result_;
                    defer ir.deinit(alloc);
                    ctx.results[i] = .{
                        .name = owned_name,
                        .version = alloc.dupe(u8, ir.version) catch owned_version,
                        .success = true,
                        .from_cache = ir.from_cache,
                    };
                } else |err| {
                    ctx.results[i] = .{
                        .name = owned_name,
                        .version = owned_version,
                        .success = false,
                        .error_msg = std.fmt.allocPrint(alloc, "{s}", .{@errorName(err)}) catch null,
                    };
                }
                continue;
            }

            // Skip other non-npm packages (handled out-of-band by caller)
            if (pkg.source != .npm) {
                ctx.results[i] = .{
                    .name = owned_name,
                    .version = owned_version,
                    .success = true,
                    .from_cache = true,
                };
                continue;
            }

            // Check if the exact resolved version is already installed on disk.
            // A name-only directory check retained stale packages after a
            // manifest constraint was bumped.
            const already_installed = installedNpmPackageMatches(
                ctx.installer.allocator,
                ctx.project_root,
                ctx.modules_dir,
                pkg.name,
                pkg.version,
                false,
            );

            if (already_installed) {
                ctx.results[i] = .{
                    .name = owned_name,
                    .version = owned_version,
                    .success = true,
                    .from_cache = true,
                    .integrity = if (pkg.pinned and pkg.integrity != null) (alloc.dupe(u8, pkg.integrity.?) catch null) else null,
                };
                continue;
            }

            if (ctx.verbose) {
                std.debug.print("[verbose:pipeline:download] downloading: {s} @ {s}\n", .{ pkg.name, pkg.version });
            }

            var exist_buf: [std.fs.max_path_bytes]u8 = undefined;
            const install_dir = std.fmt.bufPrint(&exist_buf, "{s}/{s}/{s}", .{ ctx.project_root, ctx.modules_dir, pkg.name }) catch {
                ctx.results[i] = .{ .name = owned_name, .version = owned_version, .success = false, .error_msg = null };
                continue;
            };

            // Check content-addressed cache
            const cached_tarball = ctx.installer.cache.get(pkg.name, pkg.version) catch null;
            const tarball_data = if (cached_tarball) |meta|
                io_helper.readFileAlloc(ctx.installer.allocator, meta.cache_path, 256 * 1024 * 1024) catch null
            else
                null;

            // Offline mode: if tarball isn't in the content-addressed cache, we refuse to
            // touch the network. A clear error message is surfaced via error_msg so the
            // user knows exactly which package was missing and can either re-run online
            // or pre-seed the cache.
            if (tarball_data == null and offline.isOfflineMode()) {
                const em = std.fmt.allocPrint(
                    ctx.installer.allocator,
                    "{s}@{s}: not in cache and PANTRY_OFFLINE=1 is set",
                    .{ pkg.name, pkg.version },
                ) catch null;
                ctx.results[i] = .{
                    .name = owned_name,
                    .version = owned_version,
                    .success = false,
                    .error_msg = em,
                };
                continue;
            }

            const tarball_bytes = tarball_data orelse dl_blk: {
                // Download tarball with retry
                var downloaded: ?[]const u8 = null;
                var dl_attempt: u32 = 0;
                while (dl_attempt < 3) : (dl_attempt += 1) {
                    downloaded = io_helper.httpGetWithClient(ctx.installer.http_client, ctx.installer.allocator, pkg.tarball_url) catch {
                        if (dl_attempt < 2) {
                            io_helper.nanosleep(0, (dl_attempt + 1) * 200 * std.time.ns_per_ms);
                            continue;
                        }
                        break :dl_blk null;
                    };
                    if (downloaded) |d| {
                        if (d.len > 0) break;
                        ctx.installer.allocator.free(d);
                        downloaded = null;
                    }
                }
                const dl = downloaded orelse {
                    const em: ?[]const u8 = if (pkg.pinned)
                        std.fmt.allocPrint(alloc, "could not download {s}@{s} from its pinned registry", .{ pkg.name, pkg.version }) catch null
                    else
                        null;
                    ctx.results[i] = .{ .name = owned_name, .version = owned_version, .success = false, .error_msg = em };
                    continue;
                };

                // Store in content-addressed cache
                var checksum: [32]u8 = undefined;
                std.crypto.hash.sha2.Sha256.hash(dl, &checksum, .{});
                ctx.installer.cache.put(pkg.name, pkg.version, pkg.tarball_url, checksum, dl) catch |err| {
                    if (ctx.verbose) std.debug.print("[verbose:pipeline] cache put failed: {s}\n", .{@errorName(err)});
                };

                break :dl_blk dl;
            };

            if (tarball_bytes == null) {
                ctx.results[i] = .{ .name = owned_name, .version = owned_version, .success = false, .error_msg = null };
                continue;
            }
            defer ctx.installer.allocator.free(tarball_bytes.?);

            // Integrity verification — if the resolver gave us an integrity value
            // (SRI or raw hex), make sure the bytes match before we touch disk.
            // Unknown formats are accepted silently to avoid bricking installs.
            if (pkg.integrity) |integrity| {
                if (integrity.len > 0 and !verifyIntegrity(ctx.installer.allocator, tarball_bytes.?, integrity)) {
                    const em = std.fmt.allocPrint(
                        ctx.installer.allocator,
                        "{s}@{s}: integrity mismatch (expected {s})",
                        .{ pkg.name, pkg.version, integrity[0..@min(integrity.len, 80)] },
                    ) catch null;
                    ctx.results[i] = .{
                        .name = owned_name,
                        .version = owned_version,
                        .success = false,
                        .error_msg = em,
                    };
                    continue;
                }
            }

            // Atomic extraction: extract into <install_dir>.partial first, then rename
            // to <install_dir>. A crash mid-extract leaves a `.partial` sibling that we
            // clean up on every entry, so it never lands as a half-installed package.
            var partial_buf: [std.fs.max_path_bytes]u8 = undefined;
            const partial_dir = std.fmt.bufPrint(&partial_buf, "{s}.partial", .{install_dir}) catch {
                ctx.results[i] = .{ .name = owned_name, .version = owned_version, .success = false, .error_msg = null };
                continue;
            };
            // Clean up any leftover partial from a previous run
            io_helper.deleteTree(partial_dir) catch {};
            io_helper.makePath(partial_dir) catch {
                ctx.results[i] = .{ .name = owned_name, .version = owned_version, .success = false, .error_msg = null };
                continue;
            };

            const extract_success = blk: {
                var dest = io_helper.cwd().openDir(io_helper.io, partial_dir, .{}) catch break :blk false;
                defer dest.close(io_helper.io);

                var input_reader: std.Io.Reader = .fixed(tarball_bytes.?);
                var window_buf: [65536]u8 = undefined;
                var decompressor: std.compress.flate.Decompress = .init(&input_reader, .gzip, &window_buf);
                // Use diagnostics to handle duplicate tar entries (e.g. ts-mocker has
                // dist/bin/cli.js listed twice). Without diagnostics, pipeToFileSystem
                // errors on the duplicate and aborts extraction.
                var diagnostics: std.tar.Diagnostics = .{ .allocator = ctx.installer.allocator };
                defer diagnostics.deinit();
                std.tar.pipeToFileSystem(io_helper.io, dest, &decompressor.reader, .{
                    .strip_components = 1,
                    .diagnostics = &diagnostics,
                }) catch {
                    io_helper.deleteTree(partial_dir) catch {};
                    break :blk false;
                };
                break :blk true;
            };

            if (!extract_success) {
                io_helper.deleteTree(partial_dir) catch {};
                ctx.results[i] = .{ .name = owned_name, .version = owned_version, .success = false, .error_msg = null };
                continue;
            }

            // Rename .partial → install_dir atomically. If a previous install is
            // present, we delete it first so the rename target is free.
            io_helper.accessAbsolute(install_dir, .{}) catch {
                // Good — target doesn't exist, proceed
            };
            io_helper.deleteTree(install_dir) catch {};
            io_helper.rename(partial_dir, install_dir) catch {
                // Best-effort recovery: fall back to moving by copy, then clean up.
                io_helper.makePath(install_dir) catch {};
                // Leave a breadcrumb so partial contents are cleaned next run
                io_helper.deleteTree(partial_dir) catch {};
                ctx.results[i] = .{ .name = owned_name, .version = owned_version, .success = false, .error_msg = null };
                continue;
            };

            // Create bin shims
            ctx.installer.createNpmShims(ctx.project_root, pkg.name, install_dir) catch {};

            // Record in hoisted cache
            ctx.installer.hoisted_versions.put(pkg.name, pkg.version);

            // A pinned package's lock entry always carries an integrity: the
            // registry's checksum (verified above), else that of these bytes.
            const recorded_integrity: ?[]const u8 = if (!pkg.pinned)
                null
            else if (pkg.integrity) |integrity|
                (alloc.dupe(u8, integrity) catch null)
            else
                (scopes.sha256Integrity(alloc, tarball_bytes.?) catch null);

            ctx.results[i] = .{
                .name = owned_name,
                .version = owned_version,
                .success = true,
                .from_cache = false,
                .integrity = recorded_integrity,
            };

            if (ctx.verbose) {
                std.debug.print("[verbose:pipeline:download] installed: {s} @ {s}\n", .{ pkg.name, pkg.version });
            }
        }
    }
};

// ============================================================================
// Phase 1 (Fast): Server-Side Bulk Resolution
// ============================================================================

/// Resolve the full dependency tree via a single POST to registry.pantry.dev/npm/resolve.
/// The server resolves the entire transitive tree server-side (BFS with concurrent npm fetches).
/// Falls back to client-side resolveFullTree() if the server is unreachable.
fn resolveViaRegistry(
    allocator: std.mem.Allocator,
    inst: *Installer,
    top_level_deps: []const PipelineDep,
    verbose: bool,
    native_plan: *native_deps.Plan,
) !std.ArrayList(ResolvedPackage) {
    // Build JSON body: {"dependencies":{"react":"^18","lodash":"^4",...}}
    // Only include npm packages (skip domain-style/pantry packages)
    var body_buf = std.ArrayList(u8).empty;
    defer body_buf.deinit(allocator);
    body_buf.appendSlice(allocator, "{\"dependencies\":{") catch
        return resolveFullTree(allocator, inst, top_level_deps, verbose, native_plan);

    var first = true;
    var npm_count: usize = 0;
    for (top_level_deps) |dep| {
        if (dep.source != .npm) continue;
        if (!first) body_buf.append(allocator, ',') catch continue;
        first = false;
        body_buf.append(allocator, '"') catch continue;
        body_buf.appendSlice(allocator, dep.name) catch continue;
        body_buf.appendSlice(allocator, "\":\"") catch continue;
        body_buf.appendSlice(allocator, dep.version) catch continue;
        body_buf.append(allocator, '"') catch continue;
        npm_count += 1;
    }
    body_buf.appendSlice(allocator, "}}") catch
        return resolveFullTree(allocator, inst, top_level_deps, verbose, native_plan);

    if (npm_count == 0) {
        return resolveFullTree(allocator, inst, top_level_deps, verbose, native_plan);
    }

    if (verbose) {
        std.debug.print("[verbose:pipeline:registry] POSTing {d} deps to registry.pantry.dev/npm/resolve...\n", .{npm_count});
    }

    // Single HTTP POST to resolve entire tree server-side
    const response = io_helper.httpPostJsonTimeout(
        allocator,
        "https://registry.pantry.dev/npm/resolve",
        body_buf.items,
        5000,
    ) catch {
        if (verbose) std.debug.print("[verbose:pipeline:registry] server unreachable, falling back to client-side resolution\n", .{});
        return resolveFullTree(allocator, inst, top_level_deps, verbose, native_plan);
    };
    defer allocator.free(response);

    if (response.len == 0) {
        return resolveFullTree(allocator, inst, top_level_deps, verbose, native_plan);
    }

    // Parse response
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, response, .{}) catch {
        if (verbose) std.debug.print("[verbose:pipeline:registry] failed to parse response, falling back\n", .{});
        return resolveFullTree(allocator, inst, top_level_deps, verbose, native_plan);
    };
    defer parsed.deinit();

    if (parsed.value != .object) return resolveFullTree(allocator, inst, top_level_deps, verbose, native_plan);
    const resolved_obj = parsed.value.object.get("resolved") orelse
        return resolveFullTree(allocator, inst, top_level_deps, verbose, native_plan);
    if (resolved_obj != .object) return resolveFullTree(allocator, inst, top_level_deps, verbose, native_plan);

    // Build resolved list from server response
    var resolved = std.ArrayList(ResolvedPackage).empty;
    errdefer {
        for (resolved.items) |pkg| {
            freeResolved(allocator, pkg);
        }
        resolved.deinit(allocator);
    }

    var iter = resolved_obj.object.iterator();
    while (iter.next()) |entry| {
        const pkg_name = entry.key_ptr.*;
        const pkg_val = entry.value_ptr.*;
        if (pkg_val != .object) continue;

        const version = if (pkg_val.object.get("version")) |v| (if (v == .string) v.string else continue) else continue;
        const tarball = if (pkg_val.object.get("tarball")) |t| (if (t == .string) t.string else continue) else continue;
        const integrity_val = if (pkg_val.object.get("integrity")) |i| (if (i == .string and i.string.len > 0) i.string else null) else null;

        try resolved.append(allocator, .{
            .name = try allocator.dupe(u8, pkg_name),
            .version = try allocator.dupe(u8, version),
            .tarball_url = try allocator.dupe(u8, tarball),
            .integrity = if (integrity_val) |i| try allocator.dupe(u8, i) else null,
            .source = .npm,
        });

        // Also populate hoisted cache for dedup
        inst.hoisted_versions.put(pkg_name, version);
    }

    // Check if any top-level npm deps are missing from server response.
    // The server may skip some due to dedup, caching, or resolution failures.
    // Fall back to individual resolution for those.
    var missing_count: usize = 0;
    for (top_level_deps) |dep| {
        if (dep.source != .npm) continue;

        // Check if this dep (or its alias) is in the resolved list
        var found = false;
        for (resolved.items) |pkg| {
            if (std.mem.eql(u8, pkg.name, dep.name)) {
                if (pkg.source == .pantry and dep.allow_pantry_fallback) try native_plan.add(dep.name, nativeConstraint(dep));
                found = true;
                break;
            }
        }
        if (!found) {
            // Explicit npm/scoped ownership stays on npm. Only retained auto
            // context can discover a real Pantry metadata fallback witness;
            // neither branch chooses a native version before graph closure.
            const npm_info = inst.resolveNpmPackageWithPreference(dep.name, dep.version, npmPreferenceForDep(inst, dep)) catch |err| {
                if (try nativeFallbackRoot(allocator, native_plan, dep)) {
                    try resolved.append(allocator, .{ .name = try allocator.dupe(u8, dep.name), .version = try allocator.dupe(u8, dep.version), .tarball_url = try allocator.dupe(u8, ""), .integrity = null, .source = .pantry });
                } else try resolved.append(allocator, try unresolvedNpm(allocator, dep, err));
                continue;
            };
            defer allocator.free(npm_info.version);
            defer allocator.free(npm_info.tarball_url);
            defer if (npm_info.integrity) |i| allocator.free(i);

            try resolved.append(allocator, .{
                .name = try allocator.dupe(u8, dep.name),
                .version = try allocator.dupe(u8, npm_info.version),
                .tarball_url = try allocator.dupe(u8, npm_info.tarball_url),
                .integrity = if (npm_info.integrity) |i| try allocator.dupe(u8, i) else null,
                .source = .npm,
            });
            inst.hoisted_versions.put(dep.name, npm_info.version);
            missing_count += 1;
        }
    }

    if (verbose and missing_count > 0) {
        std.debug.print("[verbose:pipeline:registry] individually resolved {d} packages missed by server\n", .{missing_count});
    }

    // Add non-npm top-level deps (pantry/github/etc) that weren't sent to the server
    for (top_level_deps) |dep| {
        if (dep.source == .npm) continue;
        if (dep.source == .pantry) try native_plan.add(dep.name, nativeConstraint(dep));
        try resolved.append(allocator, .{
            .name = try allocator.dupe(u8, dep.name),
            .version = try allocator.dupe(u8, dep.version),
            .tarball_url = try allocator.dupe(u8, ""),
            .integrity = null,
            .source = dep.source,
            .github_owner = dep.github_owner,
            .github_repo = dep.github_repo,
        });
    }

    if (verbose) {
        std.debug.print("[verbose:pipeline:registry] server resolved {d} packages (from {d} top-level deps)\n", .{ resolved.items.len, npm_count });
    }

    return resolved;
}

/// The Pantry registry bulk endpoints are an optional acceleration layer, not
/// an authoritative dependency source. Keep npm installs independent from
/// registry availability unless a caller explicitly opts into the accelerator.
fn registryAccelerationValueEnabled(value: ?[]const u8) bool {
    const raw = value orelse return false;
    return std.ascii.eqlIgnoreCase(raw, "true") or std.mem.eql(u8, raw, "1");
}

fn registryAccelerationEnabled(allocator: std.mem.Allocator) bool {
    const value = io_helper.getEnvVarOwned(allocator, "PANTRY_REGISTRY_ACCELERATION") catch return false;
    defer allocator.free(value);
    return registryAccelerationValueEnabled(value);
}

test "registry acceleration is opt-in" {
    try std.testing.expect(!registryAccelerationValueEnabled(null));
    try std.testing.expect(!registryAccelerationValueEnabled(""));
    try std.testing.expect(!registryAccelerationValueEnabled("false"));
    try std.testing.expect(registryAccelerationValueEnabled("1"));
    try std.testing.expect(registryAccelerationValueEnabled("TRUE"));
}

fn appendJsonString(allocator: std.mem.Allocator, out: *std.ArrayList(u8), value: []const u8) !void {
    try out.append(allocator, '"');
    for (value) |c| {
        switch (c) {
            '"' => try out.appendSlice(allocator, "\\\""),
            '\\' => try out.appendSlice(allocator, "\\\\"),
            '\n' => try out.appendSlice(allocator, "\\n"),
            '\r' => try out.appendSlice(allocator, "\\r"),
            '\t' => try out.appendSlice(allocator, "\\t"),
            else => {
                if (c < 0x20) {
                    const hex = "0123456789abcdef";
                    try out.appendSlice(allocator, "\\u00");
                    try out.append(allocator, hex[c >> 4]);
                    try out.append(allocator, hex[c & 0x0f]);
                } else {
                    try out.append(allocator, c);
                }
            },
        }
    }
    try out.append(allocator, '"');
}

fn isInstalledOrCached(
    inst: *Installer,
    project_root: []const u8,
    modules_dir: []const u8,
    pkg: ResolvedPackage,
) bool {
    var install_dir_buf: [std.fs.max_path_bytes]u8 = undefined;
    const install_dir = std.fmt.bufPrint(&install_dir_buf, "{s}/{s}/{s}", .{ project_root, modules_dir, pkg.name }) catch return false;
    io_helper.accessAbsolute(install_dir, .{}) catch {
        const cached = inst.cache.get(pkg.name, pkg.version) catch null;
        return cached != null;
    };

    // A directory with the right package name is not enough: constraints can
    // resolve to a newer release while an older package is still on disk. The
    // previous name-only check silently retained that stale version and then
    // rewrote pantry.lock with the new constraint as though it were resolved.
    if (pkg.source == .npm) {
        return installedNpmPackageMatches(inst.allocator, project_root, modules_dir, pkg.name, pkg.version, false);
    }

    if (pkg.source == .pantry) {
        var version_dir_buf: [std.fs.max_path_bytes]u8 = undefined;
        const version_dir = std.fmt.bufPrint(&version_dir_buf, "{s}/v{s}", .{ install_dir, pkg.version }) catch return false;
        io_helper.accessAbsolute(version_dir, .{}) catch return false;
        return true;
    }

    return false;
}

fn packageManifestHasVersion(allocator: std.mem.Allocator, manifest: []const u8, expected_version: []const u8) bool {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, manifest, .{}) catch return false;
    defer parsed.deinit();
    if (parsed.value != .object) return false;
    const version = parsed.value.object.get("version") orelse return false;
    return version == .string and std.mem.eql(u8, version.string, expected_version);
}

fn packageManifestSatisfiesConstraint(allocator: std.mem.Allocator, manifest: []const u8, version_constraint: []const u8) bool {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, manifest, .{}) catch return false;
    defer parsed.deinit();
    if (parsed.value != .object) return false;
    const version = parsed.value.object.get("version") orelse return false;
    if (version != .string) return false;
    if (std.mem.eql(u8, version.string, version_constraint)) return true;

    const semver = @import("../packages/semver.zig");
    const constraint = semver.parseConstraint(version_constraint) catch return false;
    return semver.satisfiesConstraint(version.string, constraint);
}

fn installedNpmPackageMatches(
    allocator: std.mem.Allocator,
    project_root: []const u8,
    modules_dir: []const u8,
    name: []const u8,
    expected_version: []const u8,
    accept_constraint: bool,
) bool {
    var manifest_path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const manifest_path = std.fmt.bufPrint(&manifest_path_buf, "{s}/{s}/{s}/package.json", .{ project_root, modules_dir, name }) catch return false;
    const manifest = io_helper.readFileAlloc(allocator, manifest_path, 2 * 1024 * 1024) catch return false;
    defer allocator.free(manifest);
    return if (accept_constraint)
        packageManifestSatisfiesConstraint(allocator, manifest, expected_version)
    else
        packageManifestHasVersion(allocator, manifest, expected_version);
}

test "installed package manifest must match the resolved version" {
    const allocator = std.testing.allocator;
    const manifest = "{\"name\":\"bunfig\",\"version\":\"0.15.6\"}";

    try std.testing.expect(packageManifestHasVersion(allocator, manifest, "0.15.6"));
    try std.testing.expect(!packageManifestHasVersion(allocator, manifest, "0.15.15"));
    try std.testing.expect(!packageManifestHasVersion(allocator, "{\"name\":\"bunfig\"}", "0.15.15"));
    try std.testing.expect(packageManifestSatisfiesConstraint(allocator, manifest, "^0.15.0"));
    try std.testing.expect(!packageManifestSatisfiesConstraint(allocator, manifest, "^0.15.15"));
}

fn buildNpmBulkDownloadBody(
    allocator: std.mem.Allocator,
    inst: *Installer,
    packages_to_download: []const ResolvedPackage,
    project_root: []const u8,
    modules_dir: []const u8,
) !?[]u8 {
    var body = try std.ArrayList(u8).initCapacity(allocator, packages_to_download.len * 160 + 32);
    errdefer body.deinit(allocator);

    try body.appendSlice(allocator, "{\"packages\":[");
    var first = true;
    var count: usize = 0;

    for (packages_to_download) |pkg| {
        if (pkg.source != .npm and pkg.source != .pantry) continue;
        if (pkg.tarball_url.len == 0) continue;
        if (isInstalledOrCached(inst, project_root, modules_dir, pkg)) continue;

        if (!first) try body.append(allocator, ',');
        first = false;
        try body.append(allocator, '{');
        try body.appendSlice(allocator, "\"name\":");
        try appendJsonString(allocator, &body, pkg.name);
        try body.appendSlice(allocator, ",\"version\":");
        try appendJsonString(allocator, &body, pkg.version);
        try body.appendSlice(allocator, ",\"tarball\":");
        try appendJsonString(allocator, &body, pkg.tarball_url);
        if (pkg.integrity) |integrity| {
            try body.appendSlice(allocator, ",\"integrity\":");
            try appendJsonString(allocator, &body, integrity);
        }
        try body.append(allocator, '}');
        count += 1;
    }

    try body.appendSlice(allocator, "]}");
    if (count == 0) {
        body.deinit(allocator);
        return null;
    }
    return try body.toOwnedSlice(allocator);
}

fn createBulkDownloadTempDir(allocator: std.mem.Allocator, inst: *Installer) ![]const u8 {
    const now = io_helper.clockGettime();
    const stamp = @as(u64, @intCast(now.sec)) * std.time.ns_per_s + @as(u64, @intCast(now.nsec));
    const temp_dir = try std.fmt.allocPrint(allocator, "{s}/registry-bulk-{d}", .{ inst.cache.cache_dir, stamp });
    errdefer allocator.free(temp_dir);
    try io_helper.makePath(temp_dir);
    return temp_dir;
}

fn extractBulkDownloadArchive(
    allocator: std.mem.Allocator,
    archive: []const u8,
    temp_dir: []const u8,
) !void {
    var dest = io_helper.cwd().openDir(io_helper.io, temp_dir, .{}) catch return error.FileNotFound;
    defer dest.close(io_helper.io);

    var input_reader: std.Io.Reader = .fixed(archive);
    var diagnostics: std.tar.Diagnostics = .{ .allocator = allocator };
    defer diagnostics.deinit();
    try std.tar.pipeToFileSystem(io_helper.io, dest, &input_reader, .{
        .diagnostics = &diagnostics,
    });
}

fn cacheBulkDownloadEntries(
    allocator: std.mem.Allocator,
    inst: *Installer,
    temp_dir: []const u8,
    verbose: bool,
) !usize {
    const manifest_path = try std.fmt.allocPrint(allocator, "{s}/manifest.json", .{temp_dir});
    defer allocator.free(manifest_path);

    const manifest_bytes = try io_helper.readFileAlloc(allocator, manifest_path, 16 * 1024 * 1024);
    defer allocator.free(manifest_bytes);

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, manifest_bytes, .{});
    defer parsed.deinit();

    if (parsed.value != .object) return 0;
    const packages_val = parsed.value.object.get("packages") orelse return 0;
    if (packages_val != .array) return 0;

    var cached_count: usize = 0;
    for (packages_val.array.items) |pkg_val| {
        if (pkg_val != .object) continue;
        const name = if (pkg_val.object.get("name")) |v| (if (v == .string) v.string else continue) else continue;
        const version = if (pkg_val.object.get("version")) |v| (if (v == .string) v.string else continue) else continue;
        const tarball_url = if (pkg_val.object.get("tarball")) |v| (if (v == .string) v.string else continue) else continue;
        const file = if (pkg_val.object.get("file")) |v| (if (v == .string) v.string else continue) else continue;
        const integrity = if (pkg_val.object.get("integrity")) |v| (if (v == .string and v.string.len > 0) v.string else null) else null;

        if (!std.mem.startsWith(u8, file, "packages/")) continue;
        if (std.mem.indexOf(u8, file, "..") != null or std.mem.startsWith(u8, file, "/")) continue;

        const tarball_path = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ temp_dir, file });
        defer allocator.free(tarball_path);

        const tarball_bytes = io_helper.readFileAlloc(allocator, tarball_path, 512 * 1024 * 1024) catch continue;
        defer allocator.free(tarball_bytes);

        if (integrity) |expected| {
            if (!verifyIntegrity(allocator, tarball_bytes, expected)) {
                if (verbose) std.debug.print("[verbose:pipeline:bulk-download] integrity mismatch for {s}@{s}\n", .{ name, version });
                continue;
            }
        }

        var checksum: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(tarball_bytes, &checksum, .{});
        inst.cache.put(name, version, tarball_url, checksum, tarball_bytes) catch |err| {
            if (verbose) std.debug.print("[verbose:pipeline:bulk-download] cache put failed for {s}@{s}: {s}\n", .{ name, version, @errorName(err) });
            continue;
        };
        cached_count += 1;
    }

    return cached_count;
}

/// Prefetch all missing registry tarballs through one Pantry registry response
/// stream. The download endpoint returns an uncompressed tar containing package
/// archives plus a manifest. We extract it into a temp directory, verify
/// integrity when available, then seed the normal content-addressed cache so
/// the installer below never fans out into one HTTP request per package.
fn prefetchNpmTarballsViaRegistry(
    allocator: std.mem.Allocator,
    inst: *Installer,
    resolved: []const ResolvedPackage,
    project_root: []const u8,
    modules_dir: []const u8,
    verbose: bool,
) void {
    if (offline.isOfflineMode()) return;

    const body = buildNpmBulkDownloadBody(allocator, inst, resolved, project_root, modules_dir) catch return;
    const request_body = body orelse return;
    defer allocator.free(request_body);

    if (verbose) {
        std.debug.print("[verbose:pipeline:bulk-download] POSTing registry tarball set to registry.pantry.dev/registry/download\n", .{});
    }

    const archive = io_helper.httpPostJsonWithClient(
        inst.http_client,
        allocator,
        "https://registry.pantry.dev/registry/download",
        request_body,
    ) catch blk: {
        if (verbose) std.debug.print("[verbose:pipeline:bulk-download] canonical endpoint unavailable; trying /npm/download compatibility alias\n", .{});
        break :blk io_helper.httpPostJsonWithClient(
            inst.http_client,
            allocator,
            "https://registry.pantry.dev/npm/download",
            request_body,
        ) catch {
            if (verbose) std.debug.print("[verbose:pipeline:bulk-download] stream unavailable; falling back to per-package downloads\n", .{});
            return;
        };
    };
    defer allocator.free(archive);
    if (archive.len == 0) return;

    const temp_dir = createBulkDownloadTempDir(allocator, inst) catch return;
    defer {
        io_helper.deleteTree(temp_dir) catch {};
        allocator.free(temp_dir);
    }

    extractBulkDownloadArchive(allocator, archive, temp_dir) catch |err| {
        if (verbose) std.debug.print("[verbose:pipeline:bulk-download] extract failed: {s}\n", .{@errorName(err)});
        return;
    };

    const cached = cacheBulkDownloadEntries(allocator, inst, temp_dir, verbose) catch |err| blk: {
        if (verbose) std.debug.print("[verbose:pipeline:bulk-download] cache import failed: {s}\n", .{@errorName(err)});
        break :blk 0;
    };
    if (verbose and cached > 0) {
        std.debug.print("[verbose:pipeline:bulk-download] cached {d} registry tarballs from one registry stream\n", .{cached});
    }
}

// ============================================================================
// Pipeline Entry Point
// ============================================================================

/// Remove any `<pkg>.partial` extraction dirs inside `<project_root>/<modules_dir>`
/// left over from a previously crashed install. Best-effort; any IO errors are
/// reported to the caller which logs them at verbose level.
fn cleanupStalePartials(
    allocator: std.mem.Allocator,
    project_root: []const u8,
    modules_dir: []const u8,
    verbose: bool,
) !void {
    const base = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ project_root, modules_dir });
    defer allocator.free(base);

    var dir = io_helper.openDirForIteration(base) catch return;
    defer dir.close();

    var it = dir.iterate();
    var cleaned: usize = 0;
    while (it.next() catch null) |entry| {
        if (!std.mem.endsWith(u8, entry.name, ".partial")) continue;
        const victim = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ base, entry.name });
        defer allocator.free(victim);
        io_helper.deleteTree(victim) catch continue;
        cleaned += 1;
    }
    if (verbose and cleaned > 0) {
        std.debug.print("[verbose:pipeline:recovery] cleaned {d} stale .partial dirs\n", .{cleaned});
    }
}

/// Run the 3-phase parallel install pipeline.
/// Returns results for each package (success/fail, for reporting and lockfile generation).
/// Drives the live install progress line on its own thread. The download
/// workers (the main thread included) are busy doing I/O, so a dedicated thread
/// is what keeps the spinner animating during long downloads — the whole point
/// being that a multi-second install never looks frozen.
const ProgressCtx = struct {
    completed: *std.atomic.Value(usize),
    total: usize,
    stop: *std.atomic.Value(bool),

    fn run(ctx: *ProgressCtx) void {
        var frame: usize = 0;
        // Brief grace period so cached/instant installs finish before the
        // spinner ever paints — they stay completely clean.
        io_helper.nanosleep(0, 120 * std.time.ns_per_ms);
        while (!ctx.stop.load(.acquire)) {
            const done = ctx.completed.load(.acquire);
            style.printPipelineProgress(done, ctx.total, frame);
            frame +%= 1;
            io_helper.nanosleep(0, 90 * std.time.ns_per_ms);
        }
    }
};

fn validateResolvedAutoNpmLock(policy: native_deps.Policy, inputs: []const PipelineDep, resolved: []const ResolvedPackage) !void {
    if (policy.force and !policy.frozen) return;
    const lower = @import("../deps/resolution/lockfile.zig");
    for (inputs) |dep| {
        if (dep.source != .npm or !dep.allow_pantry_fallback) continue;
        if (policy.exempt_domains) |exempt| if (exempt.contains(dep.name)) continue;
        // The resolved source, not the original auto guess, decides coverage.
        for (resolved) |pkg| {
            if (pkg.source != .npm or pkg.resolve_error != null or !std.mem.eql(u8, pkg.name, dep.name)) continue;
            const pin = if (policy.original_lock) |original|
                try lower.lockedVersionSatisfyingFromSource(original, dep.name, nativeConstraint(dep), .npm)
            else
                null;
            if (policy.frozen and (pin == null or !std.mem.eql(u8, pin.?, pkg.version))) return error.NativeLockNotSatisfied;
            break;
        }
    }
}

fn sameOptionalText(first: ?[]const u8, second: ?[]const u8) bool {
    if (first) |value| return if (second) |other| std.mem.eql(u8, value, other) else false;
    return second == null;
}

fn appendRootInput(allocator: std.mem.Allocator, inputs: *std.ArrayList(PipelineDep), root: native_deps.Root) !void {
    for (inputs.items) |input| {
        if (input.source == root.source and input.allow_pantry_fallback == root.allow_pantry_fallback and !input.optional and
            std.mem.eql(u8, input.name, root.name) and std.mem.eql(u8, nativeConstraint(input), root.version) and
            sameOptionalText(input.github_owner, root.github_owner) and sameOptionalText(input.github_repo, root.github_repo)) return;
    }
    try inputs.append(allocator, .{ .name = root.name, .version = root.version, .source = root.source, .github_owner = root.github_owner, .github_repo = root.github_repo, .allow_pantry_fallback = root.allow_pantry_fallback });
}

pub fn run(
    allocator: std.mem.Allocator,
    inst: *Installer,
    requested_deps: []const PipelineDep,
    project_root: []const u8,
    verbose: bool,
) !PipelineResult {
    var inputs: std.ArrayList(PipelineDep) = .empty;
    defer inputs.deinit(allocator);
    try inputs.appendSlice(allocator, requested_deps);
    if (inst.native_session) |session| {
        for (session.supplemental_roots) |root| {
            try appendRootInput(allocator, &inputs, root);
        }
        for (session.captured_roots.items) |root| {
            try appendRootInput(allocator, &inputs, root);
        }
    }
    for (inputs.items) |*dep| {
        if (dep.source == .ziglang) {
            dep.name = "ziglang.org";
            dep.source = .pantry;
        }
        if (dep.source == .pantry) dep.name = native_identity.canonical(dep.name);
    }
    const top_level_deps = inputs.items;
    var local_plan = native_deps.Plan.init(allocator);
    defer local_plan.deinit();
    const native_plan = if (inst.native_session) |session| blk: {
        if (session.plan == null) session.plan = native_deps.Plan.init(allocator);
        break :blk &session.plan.?;
    } else &local_plan;
    // Collect authored native edges before either resolver's name dedup. The
    // catalog closure also makes native/source conflicts independent of order.
    for (top_level_deps) |dep| {
        if (dep.source == .pantry) try native_plan.add(dep.name, nativeConstraint(dep));
    }
    try native_plan.expand();

    const total_start = io_helper.clockGettime();
    const total_start_ms = @as(i64, @intCast(total_start.sec)) * 1000 + @divFloor(@as(i64, @intCast(total_start.nsec)), 1_000_000);

    // ── Phase 0: Recovery — sweep stale `.partial` extraction dirs left behind by
    // crashed runs. Cheap (single iteration) and keeps disk clean without user action.
    cleanupStalePartials(allocator, project_root, inst.modules_dir, verbose) catch |err| {
        if (verbose) std.debug.print("[verbose:pipeline:recovery] cleanup skipped: {s}\n", .{@errorName(err)});
    };

    // ── Fast path: check if all top-level deps are already installed ──
    {
        var present_count: usize = 0;
        var npm_count: usize = 0;
        var identity_validation_pending = false;
        for (top_level_deps) |dep| {
            // Only check npm packages — system/pantry packages aren't in ./pantry/
            if (dep.source != .npm) continue;
            npm_count += 1;
            // With a bun.lock pin in range, only that exact version counts as
            // present: an older in-range copy is the drift this must repair.
            const bun_pin = inst.preferredBunPin(dep.name, dep.version);
            var frozen_pin: ?[]const u8 = null;
            if (dep.allow_pantry_fallback and (!inst.native_policy.force or inst.native_policy.frozen)) {
                const pin = if (inst.native_policy.original_lock) |original|
                    @import("../deps/resolution/lockfile.zig").lockedVersionSatisfyingFromSource(original, dep.name, nativeConstraint(dep), .npm) catch blk: {
                        identity_validation_pending = true;
                        break :blk null;
                    }
                else
                    null;
                const exempt = if (inst.native_policy.exempt_domains) |domains| domains.contains(dep.name) else false;
                if (inst.native_policy.frozen and !exempt) {
                    frozen_pin = pin;
                    if (pin == null) identity_validation_pending = true;
                    if (pin) |locked| {
                        if (bun_pin) |bun| {
                            if (!std.mem.eql(u8, locked, bun)) identity_validation_pending = true;
                        }
                    }
                }
            }
            if (installedNpmPackageMatches(
                allocator,
                project_root,
                inst.modules_dir,
                dep.name,
                frozen_pin orelse bun_pin orelse dep.version,
                frozen_pin == null and bun_pin == null,
            )) present_count += 1;
        }

        // Skip only when every top-level npm dep is present on disk. Missing
        // packages must go through resolution/download; otherwise a fresh
        // project can get an empty pantry/ with an "up to date" summary.
        const missing = npm_count - present_count;
        if (!identity_validation_pending and native_plan.names.items.len == 0 and canUseNpmFastPath(top_level_deps.len, npm_count, missing)) {
            if (verbose) {
                const check_ts = io_helper.clockGettime();
                const check_ms = @as(i64, @intCast(check_ts.sec)) * 1000 + @divFloor(@as(i64, @intCast(check_ts.nsec)), 1_000_000);
                std.debug.print("[verbose:pipeline] all {d} top-level npm deps already installed ({d}ms)\n", .{ npm_count, check_ms - total_start_ms });
            }
            // Return empty result — nothing to install
            return PipelineResult{
                .installed_count = 0,
                .cached_count = top_level_deps.len,
                .failed_count = 0,
                .results = try allocator.alloc(PackageResult, 0),
            };
        }
    }

    // ── Phase 1: Resolve full dependency tree ──
    // Resolve from npm by default. The Pantry server-side bulk resolver and
    // tarball stream remain an explicit acceleration mode, never a dependency.
    // The bulk resolver answers from npm, so it is never used while scopes
    // are pinned: a pinned name - top-level or transitive - must not get an
    // npm answer from anywhere.
    const has_scope_pins = if (inst.scope_pins) |pins| !pins.isEmpty() else false;
    const use_registry_acceleration = !has_scope_pins and registryAccelerationEnabled(allocator);
    if (verbose) {
        const source = if (use_registry_acceleration) "Pantry registry accelerator" else "npm registry";
        std.debug.print("[verbose:pipeline] Phase 1: resolving dependency tree via {s}...\n", .{source});
    }
    var resolved = if (use_registry_acceleration)
        try resolveViaRegistry(allocator, inst, top_level_deps, verbose, native_plan)
    else
        try resolveFullTree(allocator, inst, top_level_deps, verbose, native_plan);
    defer {
        for (resolved.items) |pkg| {
            freeResolved(allocator, pkg);
        }
        resolved.deinit(allocator);
    }

    // Both resolution routes discover all genuine native roots first. Only
    // now close active edges and choose versions, before any payload workers.
    try native_plan.resolve(inst.native_policy);
    var native_index: usize = 0;
    while (native_index < resolved.items.len) {
        if (resolved.items[native_index].source == .pantry) {
            freeResolved(allocator, resolved.swapRemove(native_index));
            continue;
        }
        if (native_plan.entries.contains(resolved.items[native_index].name)) return error.NativeSourceConflict;
        native_index += 1;
    }
    for (native_plan.names.items) |name| {
        const version = try native_plan.versionFor(name, "latest");
        try resolved.append(allocator, .{ .name = try allocator.dupe(u8, name), .version = try allocator.dupe(u8, version), .tarball_url = try allocator.dupe(u8, ""), .integrity = null, .source = .pantry });
    }

    try validateResolvedAutoNpmLock(inst.native_policy, top_level_deps, resolved.items);

    const phase1_ts = io_helper.clockGettime();
    const phase1_ms = @as(i64, @intCast(phase1_ts.sec)) * 1000 + @divFloor(@as(i64, @intCast(phase1_ts.nsec)), 1_000_000);
    if (verbose) {
        std.debug.print("[verbose:pipeline:timer] Phase 1 (resolve): {d}ms — {d} packages\n", .{ phase1_ms - total_start_ms, resolved.items.len });
    }

    if (resolved.items.len == 0) {
        return PipelineResult{
            .installed_count = 0,
            .cached_count = 0,
            .failed_count = 0,
            .results = try allocator.alloc(PackageResult, 0),
        };
    }

    // ── Phase 1.5: Bulk tarball prefetch through Pantry ──
    // For large npm trees, this turns N individual tarball downloads into one
    // registry response stream. The normal worker phase still handles cache
    // hits, extraction, integrity checks, and fallback if the stream is
    // unavailable or skips a tarball.
    if (use_registry_acceleration) {
        prefetchNpmTarballsViaRegistry(allocator, inst, resolved.items, project_root, inst.modules_dir, verbose);
    }

    // ── Phase 2+3: Download + Extract in parallel ──
    // Combined into one phase since downloading and extracting per-package
    // is more cache-friendly than downloading all then extracting all.
    if (verbose) std.debug.print("[verbose:pipeline] Phase 2: downloading & extracting {d} packages...\n", .{resolved.items.len});

    const results = try allocator.alloc(PackageResult, resolved.items.len);
    for (results) |*r| r.* = .{ .name = "", .version = "", .success = false };

    // Live progress: animate a single "installing X/N" line while the workers
    // download+extract. Interactive TTY only — never CI, redirected output,
    // quiet, or verbose (verbose prints its own detail). Computing it here on
    // the main thread also warms style's cached TTY/CI checks so the progress
    // thread reads them race-free.
    //
    // Multi-package only: the spinner's value is the X/N completion count. For a
    // single package it would just sit at 0/1 for the whole download while
    // suppressing the installer's own byte-level progress (e.g. zig's "MB / MB"),
    // which is far more useful — so leave single-package installs to that.
    const show_progress = !verbose and !style.isCI() and style.colorsEnabled() and !style.isQuiet() and resolved.items.len > 1;

    var next_idx = std.atomic.Value(usize).init(0);
    var completed = std.atomic.Value(usize).init(0);
    var dl_ctx = DownloadThreadCtx{
        .installer = inst,
        .packages = resolved.items,
        .results = results,
        .project_root = project_root,
        .modules_dir = inst.modules_dir,
        .next = &next_idx,
        .completed = &completed,
        .verbose = verbose,
        .show_progress = show_progress,
        .native_plan = native_plan,
    };

    var stop_progress = std.atomic.Value(bool).init(false);
    var progress_ctx = ProgressCtx{ .completed = &completed, .total = resolved.items.len, .stop = &stop_progress };
    const progress_thread: ?std.Thread = if (show_progress)
        (std.Thread.spawn(.{}, ProgressCtx.run, .{&progress_ctx}) catch null)
    else
        null;

    // Use up to 16 threads for download + extract
    const cpu_count = std.Thread.getCpuCount() catch 4;
    const max_threads = @min(cpu_count, 16);
    const thread_count = @min(resolved.items.len, max_threads);

    if (thread_count <= 1) {
        DownloadThreadCtx.worker(&dl_ctx);
    } else {
        const spawned = thread_count - 1;
        var threads = try allocator.alloc(?std.Thread, spawned);
        defer allocator.free(threads);
        for (threads) |*t| t.* = null;

        for (0..spawned) |t| {
            threads[t] = std.Thread.spawn(.{}, DownloadThreadCtx.worker, .{&dl_ctx}) catch null;
        }
        DownloadThreadCtx.worker(&dl_ctx);

        for (threads) |*t| {
            if (t.*) |thread| {
                thread.join();
                t.* = null;
            }
        }
    }

    // Stop the progress animation and wipe its line before any result output.
    if (progress_thread) |pt| {
        stop_progress.store(true, .release);
        pt.join();
        style.clearLine();
    }

    const phase2_ts = io_helper.clockGettime();
    const phase2_ms = @as(i64, @intCast(phase2_ts.sec)) * 1000 + @divFloor(@as(i64, @intCast(phase2_ts.nsec)), 1_000_000);

    // Count results
    var installed: usize = 0;
    var cached: usize = 0;
    var failed: usize = 0;
    for (results, 0..) |*r, ri| {
        if (r.lock_only) continue;
        if (r.success) {
            if (r.from_cache) cached += 1 else installed += 1;
        } else if (r.name.len > 0) {
            if (resolved.items[ri].optional and !r.policy_failure) {
                // npm and bun both carry on past an optional dependency that
                // will not install; it is neither reported nor locked.
                if (verbose) std.debug.print("[verbose:pipeline] optional {s}@{s} did not install, skipping\n", .{ r.name, r.version });
                if (r.error_msg) |msg| allocator.free(msg);
                allocator.free(r.name);
                if (r.version.len > 0) allocator.free(r.version);
                r.* = .{ .name = "", .version = "", .success = false };
                continue;
            }
            failed += 1;
        }
    }

    if (verbose) {
        std.debug.print("[verbose:pipeline:timer] Phase 2 (download+extract): {d}ms\n", .{phase2_ms - phase1_ms});
    }

    // ── Phase 3: Post-install patches ──
    // Skip gracefully when no `patchedDependencies` field is present. The patch
    // module is a no-op in that case, so the cost is one file read.
    const patch_result = patches_mod.applyPatchesIn(
        allocator,
        project_root,
        inst.modules_dir,
        verbose,
    ) catch |err| blk: {
        if (verbose) std.debug.print("[verbose:pipeline:patches] error: {s}\n", .{@errorName(err)});
        break :blk patches_mod.PatchResult{ .applied = 0, .failed = 0, .skipped = 0 };
    };
    if (verbose and (patch_result.applied + patch_result.failed + patch_result.skipped) > 0) {
        std.debug.print("[verbose:pipeline:patches] applied={d} failed={d} skipped={d}\n", .{
            patch_result.applied, patch_result.failed, patch_result.skipped,
        });
    }

    if (verbose) {
        std.debug.print("[verbose:pipeline:timer] Total pipeline: {d}ms — installed={d}, cached={d}, failed={d}\n", .{
            phase2_ms - total_start_ms, installed, cached, failed,
        });
    }

    return PipelineResult{
        .installed_count = installed,
        .cached_count = cached,
        .failed_count = failed,
        .results = results,
    };
}

test "dependency architecture guards select the actual target and retain foreign pins" {
    const spec = "darwin/x86-64:libisl.sourceforge.io^0";
    const linux = parseDepSpecForPlatform(spec, "linux", "x86_64").?;
    try std.testing.expect(linux.foreign and linux.guarded);
    try std.testing.expectEqualStrings("libisl.sourceforge.io", linux.domain);
    try std.testing.expectEqualStrings("^0", linux.version);
    try std.testing.expect(!parseDepSpecForPlatform(spec, "darwin", "x64").?.foreign);
    try std.testing.expect(parseDepSpecForPlatform(spec, "darwin", "aarch64").?.foreign);
    try std.testing.expect(!parseDepSpecForPlatform("darwin/arm64:openssl.org@3", "darwin", "aarch64").?.foreign);
    try std.testing.expect(!parseDepSpecForPlatform("linux/aarch64:openssl.org^3", "linux", "arm64").?.foreign);
    try std.testing.expect(!parseDepSpecForPlatform("windows/x86_64:zlib.net", "windows", "x64").?.foreign);
    try std.testing.expect(!parseDepSpecForPlatform("zlib.net^1", "linux", "x64").?.guarded);
    try std.testing.expect(parseDepSpecForPlatform("darwin//x64:zlib.net", "darwin", "x64") == null);
}

const NativeConflictMetadata = struct {
    fn result(allocator: std.mem.Allocator, children: []const []const u8) !Installer.NpmResolutionWithDeps {
        const version = try allocator.dupe(u8, "1.0.0");
        errdefer allocator.free(version);
        const url = try allocator.dupe(u8, "https://metadata.fixture/archive.tgz");
        errdefer allocator.free(url);
        const deps = try allocator.alloc(Installer.NpmResolutionWithDeps.DepEntry, children.len);
        var initialized: usize = 0;
        errdefer {
            for (deps[0..initialized]) |dependency| {
                allocator.free(dependency.name);
                allocator.free(dependency.version_constraint);
            }
            allocator.free(deps);
        }
        for (children, 0..) |child, index| {
            const name = try allocator.dupe(u8, child);
            errdefer allocator.free(name);
            deps[index] = .{ .name = name, .version_constraint = try allocator.dupe(u8, "^1"), .is_optional = false };
            initialized += 1;
        }
        return .{ .version = version, .tarball_url = url, .dependencies = deps };
    }

    fn resolve(ctx: *ResolveThreadCtx) !void {
        for (ctx.deps, 0..) |dep, index| {
            ctx.results[index] = try result(ctx.installer.allocator, if (std.mem.eql(u8, dep.name, "root")) &.{ "queued-child", "native-conflict", "pending-child" } else &.{"queued-grandchild"});
        }
    }
};

test "BFS native conflict releases pending metadata both owned waves and collected packages" {
    const allocator = std.testing.allocator;
    var package_cache = try @import("../cache.zig").PackageCache.init(allocator);
    defer package_cache.deinit();
    var installer = try Installer.init(allocator, &package_cache);
    defer installer.deinit();
    var plan = native_deps.Plan.init(allocator);
    defer plan.deinit();
    try plan.add("native-conflict", "^1");
    // The second wave owns current strings, one collected result plus its
    // next-wave child, and an unprocessed later result when conflict occurs.
    try std.testing.expectError(error.NativeSourceConflict, resolveFullTreeUsing(allocator, &installer, &.{.{ .name = "root", .version = "^1", .source = .npm }}, false, &plan, NativeConflictMetadata.resolve));
}

test "native fallback retains authored range instead of a wrong-source provisional npm pin" {
    const allocator = std.testing.allocator;
    const lower = @import("../deps/resolution/lockfile.zig");
    var original = try lower.LockFile.parse(allocator,
        \\{"packages":{"fixture.example@1.10.0":{"name":"fixture.example","version":"1.10.0","source":"npm"}}}
    );
    defer original.deinit();
    const Metadata = struct {
        fn witness(a: std.mem.Allocator, name: []const u8, declared: []const u8) !?ResolvedPackage {
            try std.testing.expectEqualStrings("^1", declared);
            return .{ .name = try a.dupe(u8, name), .version = try a.dupe(u8, "1.11.0"), .tarball_url = try a.dupe(u8, "https://metadata.fixture/native.tgz"), .integrity = null, .source = .pantry };
        }
        fn fresh(a: std.mem.Allocator, name: []const u8, declared: []const u8) ![]const u8 {
            const metadata = (try witness(a, name, declared)).?;
            a.free(metadata.name);
            a.free(metadata.tarball_url);
            return metadata.version;
        }
        fn unexpected(_: std.mem.Allocator, _: []const u8, _: []const u8) ![]const u8 {
            return error.UnexpectedMetadataLookup;
        }
    };
    var plan = native_deps.Plan.init(allocator);
    defer plan.deinit();
    try std.testing.expect(try nativeFallbackRootUsing(allocator, &plan, .{ .name = "fixture.example", .version = "1.10.0", .declared_constraint = "^1", .source = .npm, .allow_pantry_fallback = true }, Metadata.witness));
    try std.testing.expectEqualStrings("1.10.0", (try lower.lockedVersionSatisfying(&original, "fixture.example", "^1")).?);
    try plan.resolveUsing(.{ .original_lock = &original }, Metadata.fresh);
    try std.testing.expectEqualStrings("1.11.0", try plan.versionFor("fixture.example", "^1"));
    var frozen = native_deps.Plan.init(allocator);
    defer frozen.deinit();
    try frozen.add("fixture.example", "^1");
    try std.testing.expectError(error.NativeLockNotSatisfied, frozen.resolveUsing(.{ .original_lock = &original, .frozen = true }, Metadata.unexpected));
    try std.testing.expectEqual(@as(usize, 1), original.packages.count());
}

test "actual npm identity enforces frozen coverage and deferred ambiguity before materialization" {
    const allocator = std.testing.allocator;
    const lower = @import("../deps/resolution/lockfile.zig");
    var original = try lower.LockFile.parse(allocator,
        \\{"packages":{"fixture@1.0.0":{"name":"fixture","version":"1.0.0","source":"npm"},"fixture@1.1.0":{"name":"fixture","version":"1.1.0","source":"npm"}}}
    );
    defer original.deinit();
    var metadata = try NativeConflictMetadata.result(allocator, &.{});
    defer metadata.deinit(allocator);
    const actual_npm = try copyNpmResolution(allocator, "fixture", metadata, false, false);
    defer freeResolved(allocator, actual_npm);
    const inputs = [_]PipelineDep{.{ .name = "fixture", .version = "^1", .declared_constraint = "^1", .source = .npm, .allow_pantry_fallback = true }};
    try std.testing.expectError(error.AmbiguousLockedVersion, validateResolvedAutoNpmLock(.{ .original_lock = &original }, &inputs, &.{actual_npm}));
    try validateResolvedAutoNpmLock(.{ .original_lock = &original, .force = true }, &inputs, &.{actual_npm});
    try std.testing.expectError(error.AmbiguousLockedVersion, validateResolvedAutoNpmLock(.{ .original_lock = &original, .force = true, .frozen = true }, &inputs, &.{actual_npm}));
    var native_only = try lower.LockFile.parse(allocator,
        \\{"packages":{"fixture@1.0.0":{"name":"fixture","version":"1.0.0","source":"pantry"}}}
    );
    defer native_only.deinit();
    try std.testing.expectError(error.NativeLockNotSatisfied, validateResolvedAutoNpmLock(.{ .original_lock = &native_only, .frozen = true }, &inputs, &.{actual_npm}));
    try validateResolvedAutoNpmLock(.{ .original_lock = &native_only }, &inputs, &.{actual_npm});
}
