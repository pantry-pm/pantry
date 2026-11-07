//! Native dependency constraints and install-lifetime planning.
const std = @import("std");
const builtin = @import("builtin");
const generated = @import("../packages/generated.zig");
const semver = @import("../packages/semver.zig");
const lockfile = @import("../deps/resolution/lockfile.zig");
const downloader = @import("downloader.zig");
const native_identity = @import("../packages/native_identity.zig");

/// Parse a generated-catalog dependency spec into a domain + version
/// constraint, honoring `os:` / `os/arch:` prefixes and stripping ` # comments`.
/// Examples: `apache.org/apr^1`, `linux:gnu.org/gcc/libstdcxx^14 # since …`,
/// `gnome.org/libxml2~2.13`, `apache.org/thrift=0.22.0`, `…libstdcxx@14`.
/// Returns null when the spec targets a different OS or architecture. Returned slices point
/// into `spec_in` (a static catalog string), so callers dupe before storing.
pub fn parsePantryDepSpec(spec_in: []const u8) ?struct { domain: []const u8, version: []const u8 } {
    const parsed = parseDepSpecForOs(spec_in) orelse return null;
    return if (parsed.foreign) null else .{ .domain = parsed.domain, .version = parsed.version };
}

/// The same spec, but only when its OS or architecture guard excludes this host.
///
/// `parsePantryDepSpec` answers null for those, which is right for installing -
/// there is nothing to fetch. It is wrong for *recording*: the lockfile
/// describes the dependency graph, and that graph contains the Linux-only
/// libstdc++ whether or not this machine can install it. Discarding it on
/// regeneration is what made a committed pantry.lock unable to survive an
/// install on a second platform (pantry-pm/pantry#231).
///
/// Returns null for a spec meant for this host, and for a malformed one -
/// callers want "which pins does this host legitimately not know about", and a
/// spec nobody can parse is not one of them.
pub fn parseForeignOsDepSpec(spec_in: []const u8) ?struct { domain: []const u8, version: []const u8 } {
    const parsed = parseDepSpecForOs(spec_in) orelse return null;
    return if (parsed.foreign) .{ .domain = parsed.domain, .version = parsed.version } else null;
}

/// The same spec, but only when it carries an OS or architecture guard.
///
/// This is the question the lockfile actually needs answered, and it is not the
/// same as `parseForeignOsDepSpec`. An OS guard on a VERSION CONSTRAINT means
/// the package resolves differently per platform, in both directions:
/// `git-scm.org` declares `linux:gnu.org/gettext^0.21`, so Linux resolves
/// gettext to 0.21.1 and macOS - where the guard does not apply, and no other
/// constraint does - resolves it to 1.0.0. Both records belong in a
/// cross-platform lock.
///
/// Asking "is this guarded for an OS I am not" gets that right on macOS and
/// wrong on Linux, where the guard is the native one and nothing marks the
/// macOS version as belonging to somebody else. Asking "is this guarded at all"
/// is symmetric, which is what a lockfile that has to survive a round trip
/// needs (pantry-pm/pantry#232).
pub fn parseOsGuardedDepSpec(spec_in: []const u8) ?struct { domain: []const u8, version: []const u8 } {
    const parsed = parseDepSpecForOs(spec_in) orelse return null;
    return if (parsed.guarded) .{ .domain = parsed.domain, .version = parsed.version } else null;
}

/// The spec's domain and version whatever OS it is guarded for, if any.
///
/// Used when walking what a platform-dependent pin itself depends on: those
/// deps are usually unguarded, because the package they belong to already only
/// exists on that platform. Asking "is this guarded" of them answers no and
/// loses them.
pub fn parseAnyOsDepSpec(spec_in: []const u8) ?struct { domain: []const u8, version: []const u8 } {
    const parsed = parseDepSpecForOs(spec_in) orelse return null;
    return .{ .domain = parsed.domain, .version = parsed.version };
}

const ParsedPlatformDep = struct { domain: []const u8, version: []const u8, foreign: bool, guarded: bool };

fn normalizedDepArch(arch: []const u8) []const u8 {
    if (std.mem.eql(u8, arch, "x64") or std.mem.eql(u8, arch, "x86_64")) return "x86-64";
    if (std.mem.eql(u8, arch, "arm64")) return "aarch64";
    return arch;
}

fn parseDepSpecForOs(spec_in: []const u8) ?ParsedPlatformDep {
    const os = switch (builtin.os.tag) {
        .linux => "linux",
        .macos => "darwin",
        .windows => "windows",
        else => @tagName(builtin.os.tag),
    };
    return parseDepSpecForPlatform(spec_in, os, @tagName(builtin.cpu.arch));
}

pub fn parseDepSpecForPlatform(spec_in: []const u8, os: []const u8, arch: []const u8) ?ParsedPlatformDep {
    var spec = spec_in;
    if (std.mem.indexOfScalar(u8, spec, '#')) |h| spec = spec[0..h];
    spec = std.mem.trim(u8, spec, " \t");
    if (spec.len == 0) return null;

    var foreign = false;
    var guarded = false;

    // The same OS/architecture guards as recipe and TypeScript metadata.
    if (std.mem.indexOfScalar(u8, spec, ':')) |colon| {
        const prefix = spec[0..colon];
        const slash = std.mem.indexOfScalar(u8, prefix, '/');
        const guard_os = if (slash) |at| prefix[0..at] else prefix;
        const is_os = std.mem.eql(u8, guard_os, "linux") or std.mem.eql(u8, guard_os, "darwin") or std.mem.eql(u8, guard_os, "windows");
        if (is_os) {
            guarded = true;
            foreign = !std.mem.eql(u8, guard_os, os);
            if (slash) |at| {
                const guard_arch = prefix[at + 1 ..];
                if (guard_arch.len == 0 or std.mem.indexOfScalar(u8, guard_arch, '/') != null) return null;
                foreign = foreign or !std.mem.eql(u8, normalizedDepArch(guard_arch), normalizedDepArch(arch));
            }
            spec = std.mem.trim(u8, spec[colon + 1 ..], " \t");
        }
    }
    if (spec.len == 0) return null;

    // Split the domain from its version constraint at the first operator char.
    var vstart: usize = spec.len;
    for (spec, 0..) |c, i| {
        if (c == '^' or c == '~' or c == '>' or c == '<' or c == '=' or c == '@') {
            vstart = i;
            break;
        }
    }
    const domain = std.mem.trim(u8, spec[0..vstart], " \t");
    if (domain.len == 0) return null;
    // Skip malformed platform-tag pseudo-domains (e.g. `darwin/x86-64`).
    if (std.mem.startsWith(u8, domain, "darwin/") or std.mem.startsWith(u8, domain, "linux/") or std.mem.startsWith(u8, domain, "windows/")) return null;
    var version: []const u8 = "latest";
    if (vstart < spec.len) {
        var v = spec[vstart..];
        if (v.len > 0 and v[0] == '@') v = v[1..]; // `domain@14` → exact 14
        v = std.mem.trim(u8, v, " \t");
        if (v.len > 0) version = v;
    }
    return .{ .domain = domain, .version = version, .foreign = foreign, .guarded = guarded };
}

pub const Source = @import("../packages/types.zig").PackageSource;
pub const Root = struct { name: []const u8, version: []const u8, source: Source = .pantry, github_owner: ?[]const u8 = null, github_repo: ?[]const u8 = null, allow_pantry_fallback: bool = false };
pub const Policy = struct {
    original_lock: ?*const lockfile.LockFile = null,
    frozen: bool = false,
    force: bool = false,
    exempt_domains: ?*const std.StringHashMap(void) = null,

    fn exempt(self: Policy, name: []const u8) bool {
        if (self.exempt_domains) |domains| {
            var keys = domains.keyIterator();
            while (keys.next()) |key| if (native_identity.same(key.*, name)) return true;
        }
        return false;
    }
};

/// Only these failures are hard native-plan policy failures. Best-effort
/// adapters may propagate this precise set while handling transport/IO locally.
pub const PolicyError = error{
    AmbiguousLockedVersion,
    NativeLockNotSatisfied,
    NativeConstraintConflict,
    NativeSourceConflict,
    NativePlanNotResolved,
    NativeUnplannedDependency,
    InvalidNativeConstraint,
};

pub fn asPolicyError(err: anyerror) ?PolicyError {
    return switch (err) {
        error.AmbiguousLockedVersion => error.AmbiguousLockedVersion,
        error.NativeLockNotSatisfied => error.NativeLockNotSatisfied,
        error.NativeConstraintConflict => error.NativeConstraintConflict,
        error.NativeSourceConflict => error.NativeSourceConflict,
        error.NativePlanNotResolved => error.NativePlanNotResolved,
        error.NativeUnplannedDependency => error.NativeUnplannedDependency,
        error.InvalidNativeConstraint => error.InvalidNativeConstraint,
        else => null,
    };
}

pub fn isPolicyError(err: anyerror) bool {
    return asPolicyError(err) != null;
}

pub const Entry = struct {
    constraints: std.ArrayList([]const u8) = .empty,
    version: ?[]const u8 = null,
    committed_version: ?[]const u8 = null, // borrowed from the original lock
    tarball_url: ?[]const u8 = null,
    metadata_resolved: bool = false,
    sha256: ?[32]u8 = null,

    fn deinit(self: *Entry, allocator: std.mem.Allocator) void {
        for (self.constraints.items) |constraint| allocator.free(constraint);
        self.constraints.deinit(allocator);
        if (self.version) |version| allocator.free(version);
        if (self.tarball_url) |url| allocator.free(url);
    }
};

/// Owns all active edges, not merely the first visited name. Metadata and pin
/// choice happen only after the native root set and its catalog closure close.
pub const Plan = struct {
    allocator: std.mem.Allocator,
    entries: std.StringHashMap(Entry),
    names: std.ArrayList([]const u8) = .empty,
    expanded: usize = 0,
    frozen: bool = false,

    pub fn init(allocator: std.mem.Allocator) Plan {
        return .{ .allocator = allocator, .entries = std.StringHashMap(Entry).init(allocator) };
    }

    pub fn deinit(self: *Plan) void {
        var iterator = self.entries.iterator();
        while (iterator.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            entry.value_ptr.deinit(self.allocator);
        }
        self.entries.deinit();
        self.names.deinit(self.allocator);
    }

    pub fn add(self: *Plan, requested_name: []const u8, constraint: []const u8) !void {
        const name = native_identity.canonical(requested_name);
        if (constraint.len > 0 and !std.mem.eql(u8, constraint, "latest") and !std.mem.eql(u8, constraint, "*")) {
            _ = semver.parseConstraint(constraint) catch return error.InvalidNativeConstraint;
        }
        if (self.frozen) {
            _ = try self.versionFor(name, constraint);
            return;
        }
        if (!self.entries.contains(name)) {
            const owned = try self.allocator.dupe(u8, name);
            errdefer self.allocator.free(owned);
            try self.names.ensureUnusedCapacity(self.allocator, 1);
            try self.entries.put(owned, .{});
            self.names.appendAssumeCapacity(owned);
        }
        const entry = self.entries.getPtr(name).?;
        for (entry.constraints.items) |previous| if (std.mem.eql(u8, previous, constraint)) return;
        const owned = try self.allocator.dupe(u8, constraint);
        errdefer self.allocator.free(owned);
        try entry.constraints.append(self.allocator, owned);
    }

    pub fn expand(self: *Plan) !void {
        while (self.expanded < self.names.items.len) : (self.expanded += 1) {
            const info = generated.getPackageByDomain(self.names.items[self.expanded]) orelse continue;
            for (info.dependencies) |spec| {
                const dependency = parsePantryDepSpec(spec) orelse continue;
                // add always retains the incoming edge, even for an expanded
                // domain. Expanding children once merely breaks catalog cycles.
                try self.add(dependency.domain, dependency.version);
            }
        }
    }

    /// Pure lock preflight. Validate the entire closure before any metadata or
    /// payload work; force bypasses preference, not explicit frozen coverage.
    pub fn preflight(self: *Plan, policy: Policy) !void {
        for (self.names.items) |name| {
            const entry = self.entries.getPtr(name).?;
            if (entry.version) |version| self.allocator.free(version);
            entry.version = null;
            entry.committed_version = null;
            if (entry.tarball_url) |url| self.allocator.free(url);
            entry.tarball_url = null;
            entry.metadata_resolved = false;
            entry.sha256 = null;
        }
        for (self.names.items) |name| {
            const entry = self.entries.getPtr(name).?;
            const locked = if (!policy.exempt(name) and (!policy.force or policy.frozen))
                if (policy.original_lock) |original|
                    lockfile.lockedVersionSatisfyingAllFromSource(original, name, entry.constraints.items, .pantry) catch |err| {
                        std.debug.print("Multiple native lock versions satisfy the active constraints for {s}; narrow the declaration or run a normal pantry install --force\n", .{name});
                        return err;
                    }
                else
                    null
            else
                null;
            if (policy.frozen and !policy.exempt(name) and locked == null) {
                std.debug.print("Native lock does not cover {s}; run a normal install before --frozen-lockfile\n", .{name});
                return error.NativeLockNotSatisfied;
            }
            entry.committed_version = locked;
            if (!policy.force) {
                if (locked) |version| entry.version = try self.allocator.dupe(u8, version);
            }
        }
    }

    fn query(self: *const Plan, entry: *const Entry) ![]const u8 {
        var query_text: std.ArrayList(u8) = .empty;
        errdefer query_text.deinit(self.allocator);
        for (entry.constraints.items) |constraint| {
            if (constraint.len == 0 or std.mem.eql(u8, constraint, "latest") or std.mem.eql(u8, constraint, "*")) continue;
            if (query_text.items.len > 0) try query_text.append(self.allocator, ' ');
            try query_text.appendSlice(self.allocator, constraint);
        }
        if (query_text.items.len == 0) try query_text.appendSlice(self.allocator, "latest");
        return query_text.toOwnedSlice(self.allocator);
    }

    pub fn resolve(self: *Plan, policy: Policy) !void {
        return self.resolveArtifactsUsing(policy, lookupNativeArtifact);
    }

    /// Metadata is a real external boundary. Unit fixtures supply metadata
    /// answers here; native source identity, intersection and policy stay real.
    pub fn resolveUsing(self: *Plan, policy: Policy, comptime lookup: anytype) !void {
        const Adapter = struct {
            fn artifact(allocator: std.mem.Allocator, name: []const u8, requested: []const u8) !Artifact {
                return .{ .version = try lookup(allocator, name, requested) };
            }
        };
        return self.resolveArtifactsUsing(policy, Adapter.artifact);
    }

    /// Complete pure lock validation first, then resolve independent metadata
    /// with bounded workers. Each worker owns a distinct entry; the map and
    /// catalog closure remain fixed until every worker has joined.
    pub fn resolveArtifactsUsing(self: *Plan, policy: Policy, comptime lookup: anytype) !void {
        if (self.frozen) return;
        try self.expand();
        try self.preflight(policy);

        const Worker = struct {
            plan: *Plan,
            policy: Policy,
            next: std.atomic.Value(usize) = std.atomic.Value(usize).init(0),
            failures: []?anyerror,

            fn resolveEntry(ctx: *@This(), index: usize) !void {
                const name = ctx.plan.names.items[index];
                const entry = ctx.plan.entries.getPtr(name).?;
                if (entry.version != null) return;
                const requested = try ctx.plan.query(entry);
                defer ctx.plan.allocator.free(requested);
                const artifact = try lookup(ctx.plan.allocator, name, requested);
                entry.version = artifact.version;
                entry.tarball_url = artifact.tarball_url;
                entry.sha256 = artifact.sha256;
                entry.metadata_resolved = true;
                for (entry.constraints.items) |constraint| {
                    if (!lockfile.resolvedVersionSatisfies(entry.version.?, constraint)) return error.NativeConstraintConflict;
                }
                if (ctx.policy.frozen and !ctx.policy.exempt(name) and !std.mem.eql(u8, entry.committed_version.?, entry.version.?)) return error.NativeLockNotSatisfied;
            }

            fn run(ctx: *@This()) void {
                while (true) {
                    const index = ctx.next.fetchAdd(1, .monotonic);
                    if (index >= ctx.plan.names.items.len) return;
                    ctx.resolveEntry(index) catch |err| {
                        ctx.failures[index] = err;
                    };
                }
            }
        };
        const failures = try self.allocator.alloc(?anyerror, self.names.items.len);
        defer self.allocator.free(failures);
        @memset(failures, null);
        var worker = Worker{ .plan = self, .policy = policy, .failures = failures };
        const thread_count = @min(self.names.items.len, @min(std.Thread.getCpuCount() catch 4, 16));
        const threads = try self.allocator.alloc(?std.Thread, thread_count -| 1);
        defer self.allocator.free(threads);
        for (threads) |*thread| thread.* = std.Thread.spawn(.{}, Worker.run, .{&worker}) catch null;
        Worker.run(&worker);
        for (threads) |thread| if (thread) |running| running.join();
        // Return failures in stable graph order rather than worker timing.
        for (failures) |failure| {
            if (failure) |err| return err;
        }
        self.frozen = true;
    }

    /// A null result means a compatible lock pin supplied the version without
    /// metadata. A non-null result may still have no URL (catalog fallback).
    pub fn artifactFor(self: *const Plan, name: []const u8, constraint: []const u8) !?Artifact {
        const version = try self.versionFor(name, constraint);
        const entry = self.entries.get(native_identity.canonical(name)).?;
        if (!entry.metadata_resolved) return null;
        return .{ .version = version, .tarball_url = entry.tarball_url, .sha256 = entry.sha256 };
    }

    pub fn versionFor(self: *const Plan, name: []const u8, constraint: []const u8) ![]const u8 {
        if (!self.frozen) return error.NativePlanNotResolved;
        const entry = self.entries.get(native_identity.canonical(name)) orelse {
            std.debug.print("Native dependency {s}@{s} was not in the completed catalog plan; declare its runtime dependency before installation\n", .{ name, constraint });
            return error.NativeUnplannedDependency;
        };
        const version = entry.version orelse return error.NativeUnplannedDependency;
        if (!lockfile.resolvedVersionSatisfies(version, constraint)) {
            std.debug.print("Native plan selected {s}@{s}, which does not satisfy active constraint {s}\n", .{ name, version, constraint });
            return error.NativeConstraintConflict;
        }
        return version;
    }
};

/// Lookup results own both slices. A completed plan retains them until deinit;
/// artifactFor returns borrowed slices to installers sharing that plan.
pub const Artifact = struct { version: []const u8, tarball_url: ?[]const u8 = null, sha256: ?[32]u8 = null };

fn lookupNativeArtifact(allocator: std.mem.Allocator, name: []const u8, requested: []const u8) !Artifact {
    if (try downloader.lookupS3Registry(allocator, name, requested)) |found| {
        return .{ .version = found.version, .tarball_url = found.tarball_url, .sha256 = found.sha256 };
    }
    if (try downloader.lookupPantryPublished(allocator, name, requested)) |found| {
        return .{ .version = found.version, .tarball_url = found.tarball_url, .sha256 = found.sha256 };
    }
    if (std.mem.eql(u8, name, "ziglang.org")) return .{ .version = try downloader.resolveZigDevVersion(allocator, requested) };
    return .{ .version = try lookupCatalogVersion(allocator, name, requested) };
}

/// Only reached after both registry metadata sources declined the request.
/// Catalog absence is distinct from a known package with no matching version.
fn lookupCatalogVersion(allocator: std.mem.Allocator, name: []const u8, requested: []const u8) ![]const u8 {
    const domain = native_identity.canonical(name);
    if (generated.getPackageByDomain(domain) == null) return error.PackageNotFound;
    const selected = semver.resolveVersion(domain, requested) orelse return error.NativeConstraintConflict;
    return allocator.dupe(u8, selected);
}

/// One whole CLI invocation owns this context across workspace and companion
/// phases. Exempt keys are adopted from the existing inferred-only closure.
pub const Session = struct {
    allocator: std.mem.Allocator,
    original_lock: ?*const lockfile.LockFile,
    frozen: bool,
    force: bool,
    exempt_domains: std.StringHashMap(void),
    supplemental_roots: []const Root = &.{},
    captured_roots: std.ArrayList(Root) = .empty,
    plan: ?Plan = null,

    pub fn init(allocator: std.mem.Allocator, original: ?*const lockfile.LockFile, frozen: bool, force: bool) Session {
        return .{ .allocator = allocator, .original_lock = original, .frozen = frozen, .force = force, .exempt_domains = std.StringHashMap(void).init(allocator) };
    }

    pub fn deinit(self: *Session) void {
        if (self.plan) |*plan| plan.deinit();
        for (self.captured_roots.items) |root| {
            self.allocator.free(root.name);
            self.allocator.free(root.version);
            if (root.github_owner) |owner| self.allocator.free(owner);
            if (root.github_repo) |repo| self.allocator.free(repo);
        }
        self.captured_roots.deinit(self.allocator);
        var iterator = self.exempt_domains.keyIterator();
        while (iterator.next()) |name| self.allocator.free(name.*);
        self.exempt_domains.deinit();
    }

    pub fn captureRoot(self: *Session, root: Root) !void {
        const name = try self.allocator.dupe(u8, root.name);
        errdefer self.allocator.free(name);
        const version = try self.allocator.dupe(u8, root.version);
        errdefer self.allocator.free(version);
        const owner = if (root.github_owner) |value| try self.allocator.dupe(u8, value) else null;
        errdefer if (owner) |value| self.allocator.free(value);
        const repo = if (root.github_repo) |value| try self.allocator.dupe(u8, value) else null;
        errdefer if (repo) |value| self.allocator.free(value);
        try self.captured_roots.append(self.allocator, .{ .name = name, .version = version, .source = root.source, .github_owner = owner, .github_repo = repo, .allow_pantry_fallback = root.allow_pantry_fallback });
    }

    pub fn adoptExemptDomains(self: *Session, domains: std.StringHashMap(void)) void {
        var iterator = self.exempt_domains.keyIterator();
        while (iterator.next()) |name| self.allocator.free(name.*);
        self.exempt_domains.deinit();
        self.exempt_domains = domains;
    }

    pub fn policy(self: *const Session) Policy {
        return .{ .original_lock = self.original_lock, .frozen = self.frozen, .force = self.force, .exempt_domains = &self.exempt_domains };
    }
};

const NoMetadata = struct {
    fn lookup(_: std.mem.Allocator, _: []const u8, _: []const u8) ![]const u8 {
        return error.UnexpectedNativeMetadataLookup;
    }
};

const MetadataFixture = struct {
    fn lookup(allocator: std.mem.Allocator, _: []const u8, constraint: []const u8) ![]const u8 {
        const parsed = try std.json.parseFromSlice(std.json.Value, allocator,
            \\{"1.10.0":{"platforms":{"fixture":{"tarball":"old.tar.gz","sha256":"old","size":1}}},
            \\ "1.11.0":{"platforms":{"fixture":{"tarball":"new.tar.gz","sha256":"new","size":1}}}}
        , .{});
        defer parsed.deinit();
        const selected = downloader.registry_versions.select(parsed.value.object, constraint, "fixture") orelse return error.NativeConstraintConflict;
        return allocator.dupe(u8, selected.version);
    }
};

fn retainedFixture(allocator: std.mem.Allocator) !lockfile.LockFile {
    return lockfile.LockFile.parse(allocator,
        \\{"packages":{
        \\ "fixture.example@1.10.0":{"name":"fixture.example","version":"1.10.0","source":"pantry"},
        \\ "fixture.example@1.11.0":{"name":"fixture.example","version":"1.11.0","source":"pantry"},
        \\ "fixture.example@1.12.0":{"name":"fixture.example","version":"1.12.0","source":"npm"}
        \\}}
    );
}

test "all native incoming constraints disambiguate pins independently of encounter order" {
    const allocator = std.testing.allocator;
    var original = try retainedFixture(allocator);
    defer original.deinit();
    for ([_]bool{ false, true }) |reverse| {
        var plan = Plan.init(allocator);
        defer plan.deinit();
        try plan.add("fixture.example", if (reverse) ">=1.10 <1.11" else "latest");
        try plan.add("fixture.example", if (reverse) "latest" else ">=1.10 <1.11");
        try plan.resolveUsing(.{ .original_lock = &original, .frozen = true }, NoMetadata.lookup);
        try std.testing.expectEqualStrings("1.10.0", try plan.versionFor("fixture.example", "^1"));
        try std.testing.expectError(error.NativeConstraintConflict, plan.versionFor("fixture.example", "^2"));
        try std.testing.expectError(error.NativeUnplannedDependency, plan.versionFor("unplanned.example", "latest"));
    }
    try std.testing.expectEqual(@as(usize, 3), original.packages.count());
}

test "genuine native ambiguity and incompatible frozen coverage stop before metadata" {
    const allocator = std.testing.allocator;
    var original = try retainedFixture(allocator);
    defer original.deinit();
    var ambiguous = Plan.init(allocator);
    defer ambiguous.deinit();
    try ambiguous.add("fixture.example", "^1");
    try std.testing.expectError(error.AmbiguousLockedVersion, ambiguous.resolveUsing(.{ .original_lock = &original }, NoMetadata.lookup));
    var missing = Plan.init(allocator);
    defer missing.deinit();
    try missing.add("fixture.example", "^2");
    try std.testing.expectError(error.NativeLockNotSatisfied, missing.resolveUsing(.{ .original_lock = &original, .frozen = true }, NoMetadata.lookup));
}

test "normal native updates force and env exemption use real metadata selection under every bound" {
    const allocator = std.testing.allocator;
    var original = lockfile.LockFile.init(allocator);
    defer original.deinit();
    try original.addPackage("fixture.example", "1.10.0", "registry:fixture.example@1.10.0", null);
    var kept = Plan.init(allocator);
    defer kept.deinit();
    try kept.add("fixture.example", "^1");
    try kept.resolveUsing(.{ .original_lock = &original }, NoMetadata.lookup);
    try std.testing.expectEqualStrings("1.10.0", try kept.versionFor("fixture.example", "^1"));
    var forced = Plan.init(allocator);
    defer forced.deinit();
    try forced.add("fixture.example", "^1");
    try forced.resolveUsing(.{ .original_lock = &original, .force = true }, MetadataFixture.lookup);
    try std.testing.expectEqualStrings("1.11.0", try forced.versionFor("fixture.example", "^1"));
    var forced_frozen = Plan.init(allocator);
    defer forced_frozen.deinit();
    try forced_frozen.add("fixture.example", "^1");
    try std.testing.expectError(error.NativeLockNotSatisfied, forced_frozen.resolveUsing(.{ .original_lock = &original, .force = true, .frozen = true }, MetadataFixture.lookup));
    try std.testing.expectError(error.NativePlanNotResolved, forced_frozen.versionFor("fixture.example", "^1"));
    var changed = Plan.init(allocator);
    defer changed.deinit();
    try changed.add("fixture.example", ">=1.11");
    try changed.add("fixture.example", "<1.12");
    try changed.resolveUsing(.{ .original_lock = &original }, MetadataFixture.lookup);
    try std.testing.expectEqualStrings("1.11.0", try changed.versionFor("fixture.example", ">=1.11 <1.12"));
    var exempt = std.StringHashMap(void).init(allocator);
    defer exempt.deinit();
    try exempt.put("fixture.example", {});
    var inferred = Plan.init(allocator);
    defer inferred.deinit();
    try inferred.add("fixture.example", "^1");
    try inferred.resolveUsing(.{ .frozen = true, .exempt_domains = &exempt }, MetadataFixture.lookup);
    try std.testing.expectEqualStrings("1.11.0", try inferred.versionFor("fixture.example", "^1"));
}

test "wrong source is normal ineligibility but cannot cover frozen native resolution" {
    const allocator = std.testing.allocator;
    var original = try lockfile.LockFile.parse(allocator,
        \\{"packages":{"fixture.example@1.10.0":{"name":"fixture.example","version":"1.10.0","source":"npm"}}}
    );
    defer original.deinit();
    var normal = Plan.init(allocator);
    defer normal.deinit();
    try normal.add("fixture.example", "^1");
    try normal.resolveUsing(.{ .original_lock = &original }, MetadataFixture.lookup);
    try std.testing.expectEqualStrings("1.11.0", try normal.versionFor("fixture.example", "^1"));
    var frozen = Plan.init(allocator);
    defer frozen.deinit();
    try frozen.add("fixture.example", "^1");
    try std.testing.expectError(error.NativeLockNotSatisfied, frozen.resolveUsing(.{ .original_lock = &original, .frozen = true }, NoMetadata.lookup));
}

test "unresolved plans cannot supply a materialization version" {
    var plan = Plan.init(std.testing.allocator);
    defer plan.deinit();
    try plan.add("fixture.example", "^1");
    try std.testing.expectError(error.NativePlanNotResolved, plan.versionFor("fixture.example", "^1"));
}

test "workspace captured roots own all constraints across phase boundaries" {
    const allocator = std.testing.allocator;
    var original = try retainedFixture(allocator);
    defer original.deinit();
    var session = Session.init(allocator, &original, true, false);
    defer session.deinit();
    const temporary_name = try allocator.dupe(u8, "fixture.example");
    const temporary_constraint = try allocator.dupe(u8, ">=1.10 <1.11");
    try session.captureRoot(.{ .name = temporary_name, .version = temporary_constraint });
    allocator.free(temporary_name);
    allocator.free(temporary_constraint);
    // A companion contributes the broad edge; the workspace's narrowing edge
    // remains owned after its parse arrays disappear. Neither phase picks first.
    session.plan = Plan.init(allocator);
    try session.plan.?.add("fixture.example", "latest");
    for (session.captured_roots.items) |root| try session.plan.?.add(root.name, root.version);
    try session.plan.?.resolveUsing(session.policy(), NoMetadata.lookup);
    try std.testing.expectEqualStrings("1.10.0", try session.plan.?.versionFor("fixture.example", "^1"));
    // A later phase verifies compatible roots against the frozen plan; it
    // cannot reopen resolution, change the version or admit another package.
    try session.plan.?.add("fixture.example", "^1");
    try std.testing.expectError(error.NativeUnplannedDependency, session.plan.?.add("late.example", "latest"));
}

test "malformed native constraints fail before metadata or materialization" {
    var plan = Plan.init(std.testing.allocator);
    defer plan.deinit();
    try std.testing.expectError(error.InvalidNativeConstraint, plan.add("fixture.example", "not-a-constraint"));
    try std.testing.expectEqual(@as(usize, 0), plan.names.items.len);
}

test "native catalog fallback distinguishes missing packages from unsatisfied known constraints" {
    const allocator = std.testing.allocator;
    try std.testing.expectError(error.PackageNotFound, lookupCatalogVersion(allocator, "test-pkg", "1.0.0"));
    try std.testing.expectError(error.NativeConstraintConflict, lookupCatalogVersion(allocator, "lz4.org", "^999999"));
    const matched = try lookupCatalogVersion(allocator, "lz4.org", "1.10.0");
    defer allocator.free(matched);
    try std.testing.expectEqualStrings("1.10.0", matched);
}

test "native aliases retain every edge and a compatible legacy pin without metadata" {
    const allocator = std.testing.allocator;
    var original = try lockfile.LockFile.parse(allocator,
        \\{"packages":{"bun.sh@1.4.3":{"name":"bun.sh","version":"1.4.3","source":"pantry","resolved":"registry:bun.sh@1.4.3"}}}
    );
    defer original.deinit();
    var plan = Plan.init(allocator);
    defer plan.deinit();
    try plan.add("bun.sh", "^1.4");
    try plan.add("bun.com", "<1.4.4");
    try plan.add("bun", "^1");
    try std.testing.expectEqual(@as(usize, 1), plan.names.items.len);
    try std.testing.expectEqualStrings("bun.com", plan.names.items[0]);
    try std.testing.expectEqual(@as(usize, 3), plan.entries.get("bun.com").?.constraints.items.len);
    try plan.resolveUsing(.{ .original_lock = &original, .frozen = true }, NoMetadata.lookup);
    inline for (.{ "bun", "bun.sh", "bun.com" }) |name| {
        try std.testing.expectEqualStrings("1.4.3", try plan.versionFor(name, "^1"));
        try std.testing.expect((try plan.artifactFor(name, "^1")) == null);
    }
    try std.testing.expectError(error.NativeConstraintConflict, plan.add("bun.sh", ">=1.4.4"));
    const catalog_version = try lookupCatalogVersion(allocator, "bun.sh", "1.4.3");
    defer allocator.free(catalog_version);
    try std.testing.expectEqualStrings("1.4.3", catalog_version);
}

const ArtifactFixture = struct {
    var calls = std.atomic.Value(usize).init(0);

    fn lookup(allocator: std.mem.Allocator, name: []const u8, _: []const u8) !Artifact {
        _ = calls.fetchAdd(1, .monotonic);
        const version = try allocator.dupe(u8, "1.10.0");
        errdefer allocator.free(version);
        return .{ .version = version, .tarball_url = try std.fmt.allocPrint(allocator, "https://fixture.example/{s}/1.10.0.tar.gz", .{name}) };
    }

    fn failOne(allocator: std.mem.Allocator, name: []const u8, requested: []const u8) !Artifact {
        if (std.mem.eql(u8, name, "missing.example")) {
            _ = calls.fetchAdd(1, .monotonic);
            return error.RegistryUnavailable;
        }
        return lookup(allocator, name, requested);
    }
};

test "native metadata retains each selected artifact across the completed plan lifetime" {
    const allocator = std.testing.allocator;
    ArtifactFixture.calls.store(0, .monotonic);
    var plan = Plan.init(allocator);
    defer plan.deinit();
    for (0..32) |index| {
        const name = try std.fmt.allocPrint(allocator, "fixture-{d}.example", .{index});
        defer allocator.free(name);
        try plan.add(name, "~1.10");
    }
    try plan.resolveArtifactsUsing(.{}, ArtifactFixture.lookup);
    try std.testing.expectEqual(@as(usize, 32), ArtifactFixture.calls.load(.monotonic));
    for (plan.names.items) |name| {
        const artifact = (try plan.artifactFor(name, "^1")).?;
        try std.testing.expectEqualStrings("1.10.0", artifact.version);
        const expected = try std.fmt.allocPrint(allocator, "https://fixture.example/{s}/1.10.0.tar.gz", .{name});
        defer allocator.free(expected);
        try std.testing.expectEqualStrings(expected, artifact.tarball_url.?);
    }
    try plan.resolveArtifactsUsing(.{}, ArtifactFixture.failOne);
    try std.testing.expectEqual(@as(usize, 32), ArtifactFixture.calls.load(.monotonic));
}

test "native metadata errors join all workers and retain no stale artifact on retry" {
    ArtifactFixture.calls.store(0, .monotonic);
    var plan = Plan.init(std.testing.allocator);
    defer plan.deinit();
    try plan.add("first.example", "^1");
    try plan.add("missing.example", "^1");
    try plan.add("last.example", "^1");
    try std.testing.expectError(error.RegistryUnavailable, plan.resolveArtifactsUsing(.{}, ArtifactFixture.failOne));
    try std.testing.expectEqual(@as(usize, 3), ArtifactFixture.calls.load(.monotonic));
    try std.testing.expectError(error.NativePlanNotResolved, plan.artifactFor("first.example", "^1"));
    try plan.resolveArtifactsUsing(.{}, ArtifactFixture.lookup);
    try std.testing.expectEqual(@as(usize, 6), ArtifactFixture.calls.load(.monotonic));
    try std.testing.expectEqualStrings("1.10.0", (try plan.artifactFor("missing.example", "^1")).?.version);
}

test "native metadata preserves lock preference and validates frozen coverage before any worker" {
    const allocator = std.testing.allocator;
    var original = try retainedFixture(allocator);
    defer original.deinit();
    ArtifactFixture.calls.store(0, .monotonic);
    var kept = Plan.init(allocator);
    defer kept.deinit();
    try kept.add("fixture.example", "~1.10");
    try kept.resolveArtifactsUsing(.{ .original_lock = &original }, ArtifactFixture.lookup);
    try std.testing.expectEqual(@as(usize, 0), ArtifactFixture.calls.load(.monotonic));
    try std.testing.expect((try kept.artifactFor("fixture.example", "^1")) == null);
    var frozen = Plan.init(allocator);
    defer frozen.deinit();
    try frozen.add("fixture.example", "~1.10");
    try frozen.add("missing.example", "^1");
    try std.testing.expectError(error.NativeLockNotSatisfied, frozen.resolveArtifactsUsing(.{ .original_lock = &original, .frozen = true }, ArtifactFixture.lookup));
    try std.testing.expectEqual(@as(usize, 0), ArtifactFixture.calls.load(.monotonic));
    var incompatible = Plan.init(allocator);
    defer incompatible.deinit();
    try incompatible.add("fixture.example", "^2");
    try std.testing.expectError(error.NativeConstraintConflict, incompatible.resolveArtifactsUsing(.{}, ArtifactFixture.lookup));
    try std.testing.expectError(error.NativePlanNotResolved, incompatible.artifactFor("fixture.example", "^2"));
}
