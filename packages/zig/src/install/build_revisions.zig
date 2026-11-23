//! Replacing defective builds with their build revisions.
//!
//! A build revision (`facebook.com/zstd` 1.5.7.2, from a recipe's
//! `revisions`) is a packaging rebuild of one upstream release, published
//! because the earlier build is broken: the 1.5.7 Linux artifact carries the
//! RPATH `/../lib`, so its `zstd` loads the host's libzstd and dies on the
//! private POOL_* symbols it imports.
//!
//! Resolution alone never reached a tree that already had the old build. A
//! lock pin keeps its version while the spec allows it, and a named install
//! of packages that are already present and satisfied never re-walks their
//! dependencies, so a runner converged before the revision existed kept 1.5.7
//! through every later `pantry install`. `reconcile` runs before the install
//! proper: every locked or installed build with a later build of the same
//! upstream release published for this platform is replaced by the newest
//! such build, installed into the tree (its `.bin` and `vN` links follow),
//! and recorded in pantry.lock so that pin is reproducible from then on.
//!
//! It never moves an upstream version (only builds of the identical release
//! qualify), and it leaves an exact pin the user wrote, in the dependency file
//! or on the command line, alone.

const std = @import("std");
const io_helper = @import("../io_helper.zig");
const semver = @import("../packages/semver.zig");
const generated = @import("../packages/generated.zig");
const lockfile_io = @import("../packages/lockfile.zig");
const pkg_types = @import("../packages/types.zig");

/// A version the user named exactly; its own build is the one they want.
pub const ExactPin = struct {
    domain: []const u8,
    version: []const u8,
};

pub const Hooks = struct {
    context: *anyopaque,
    /// The newest build in `range` with a complete artifact for this
    /// platform (caller owns it), or null when none is published here.
    newestPublished: *const fn (context: *anyopaque, allocator: std.mem.Allocator, domain: []const u8, range: []const u8) anyerror!?[]u8,
    /// Install exactly `domain@version` into the project tree, links included.
    install: *const fn (context: *anyopaque, domain: []const u8, version: []const u8) anyerror!void,
};

pub const Options = struct {
    project_root: []const u8,
    modules_dir: []const u8 = "pantry",
    exact_pins: []const ExactPin = &.{},
    /// Write pantry.lock when an entry moved (`--no-save` turns it off).
    save_lockfile: bool = true,
};

pub const Change = struct {
    domain: []const u8,
    from: []const u8,
    to: []const u8,

    pub fn deinit(self: Change, allocator: std.mem.Allocator) void {
        allocator.free(self.domain);
        allocator.free(self.from);
        allocator.free(self.to);
    }
};

pub fn freeChanges(allocator: std.mem.Allocator, changes: []Change) void {
    for (changes) |change| change.deinit(allocator);
    allocator.free(changes);
}

const Candidate = struct {
    domain: []const u8,
    version: []const u8,
    lock_key: ?[]const u8,
};

fn domainOf(name: []const u8) []const u8 {
    return if (generated.getPackageByName(name)) |pkg| pkg.domain else name;
}

fn isExactPin(pins: []const ExactPin, domain: []const u8, version: []const u8) bool {
    for (pins) |pin| {
        if (std.mem.eql(u8, domainOf(pin.domain), domain) and std.mem.eql(u8, pin.version, version)) return true;
    }
    return false;
}

fn hasCandidate(list: []const Candidate, domain: []const u8) bool {
    for (list) |item| if (std.mem.eql(u8, item.domain, domain)) return true;
    return false;
}

/// The newest real version directory of `domain` in the tree (`v1` and
/// `v1.5` are links to it), or null. Caller owns the result.
fn newestInstalled(allocator: std.mem.Allocator, tree: []const u8, domain: []const u8) ?[]u8 {
    const path = std.fs.path.join(allocator, &.{ tree, domain }) catch return null;
    defer allocator.free(path);
    var dir = io_helper.openDirAbsoluteForIteration(path) catch return null;
    defer dir.close();
    var best: ?[]u8 = null;
    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (entry.kind != .directory) continue;
        if (entry.name.len < 2 or entry.name[0] != 'v' or !std.ascii.isDigit(entry.name[1])) continue;
        const version = entry.name[1..];
        if (best) |current| if (semver.compareVersions(version, current) != .gt) continue;
        const owned = allocator.dupe(u8, version) catch continue;
        if (best) |current| allocator.free(current);
        best = owned;
    }
    return best;
}

/// Replace superseded builds in the project at `options.project_root`.
/// Returns what moved (caller frees with `freeChanges`).
pub fn reconcile(allocator: std.mem.Allocator, options: Options, hooks: Hooks) ![]Change {
    var changes: std.ArrayList(Change) = .empty;
    errdefer {
        for (changes.items) |change| change.deinit(allocator);
        changes.deinit(allocator);
    }

    var candidates: std.ArrayList(Candidate) = .empty;
    defer {
        for (candidates.items) |item| {
            allocator.free(item.domain);
            allocator.free(item.version);
            if (item.lock_key) |key| allocator.free(key);
        }
        candidates.deinit(allocator);
    }

    const lock_path = try std.fs.path.join(allocator, &.{ options.project_root, "pantry.lock" });
    defer allocator.free(lock_path);
    var lock: ?pkg_types.Lockfile = lockfile_io.readLockfile(allocator, lock_path) catch null;
    defer if (lock) |*l| l.deinit(allocator);

    // Locked builds first: the lock is what the next install would honour.
    if (lock) |*l| {
        var it = l.packages.iterator();
        while (it.next()) |entry| {
            const pkg = entry.value_ptr.*;
            if (pkg.source != .pantry) continue;
            const domain = domainOf(pkg.name);
            if (!semver.hasNewerBuildRevision(semver.catalogBuildRevisions(domain), pkg.version, null)) continue;
            if (hasCandidate(candidates.items, domain)) continue;
            const owned_domain = try allocator.dupe(u8, domain);
            errdefer allocator.free(owned_domain);
            const owned_version = try allocator.dupe(u8, pkg.version);
            errdefer allocator.free(owned_version);
            const key = try allocator.dupe(u8, entry.key_ptr.*);
            errdefer allocator.free(key);
            try candidates.append(allocator, .{ .domain = owned_domain, .version = owned_version, .lock_key = key });
        }
    }

    // Then builds that are only on disk.
    const tree = try std.fs.path.join(allocator, &.{ options.project_root, options.modules_dir });
    defer allocator.free(tree);
    for (&generated.packages) |*pkg| {
        if (pkg.build_revisions.len == 0 or hasCandidate(candidates.items, pkg.domain)) continue;
        const version = newestInstalled(allocator, tree, pkg.domain) orelse continue;
        if (!semver.hasNewerBuildRevision(pkg.build_revisions, version, null)) {
            allocator.free(version);
            continue;
        }
        errdefer allocator.free(version);
        const owned_domain = try allocator.dupe(u8, pkg.domain);
        errdefer allocator.free(owned_domain);
        try candidates.append(allocator, .{ .domain = owned_domain, .version = version, .lock_key = null });
    }

    var lock_changed = false;
    for (candidates.items) |item| {
        if (isExactPin(options.exact_pins, item.domain, item.version)) continue;
        const range = (try semver.revisionRange(allocator, semver.catalogBuildRevisions(item.domain), item.version)) orelse continue;
        defer allocator.free(range);
        const target = (hooks.newestPublished(hooks.context, allocator, item.domain, range) catch null) orelse continue;
        var target_owned = true;
        defer if (target_owned) allocator.free(target);
        // A lookup over the range can only answer with a later build of the
        // same release; check anyway rather than move an upstream version.
        const position = semver.buildPosition(semver.catalogBuildRevisions(item.domain), target) orelse continue;
        const from = semver.buildPosition(semver.catalogBuildRevisions(item.domain), item.version) orelse continue;
        if (!std.mem.eql(u8, position.release, from.release) or position.build <= from.build) continue;

        hooks.install(hooks.context, item.domain, target) catch continue;

        if (item.lock_key) |key| if (lock) |*l| {
            if (l.packages.fetchRemove(key)) |kv| {
                var old = kv.value;
                defer old.deinit(allocator);
                allocator.free(kv.key);
                const name = try allocator.dupe(u8, old.name);
                errdefer allocator.free(name);
                const version = try allocator.dupe(u8, target);
                errdefer allocator.free(version);
                const new_key = try std.fmt.allocPrint(allocator, "{s}@{s}", .{ old.name, target });
                defer allocator.free(new_key);
                // A later build of the same release may already be locked.
                if (l.packages.fetchRemove(new_key)) |dup| {
                    var stale = dup.value;
                    stale.deinit(allocator);
                    allocator.free(dup.key);
                }
                try l.addEntry(allocator, new_key, .{ .name = name, .version = version, .source = .pantry });
                lock_changed = true;
            }
        };

        const owned_domain = try allocator.dupe(u8, item.domain);
        errdefer allocator.free(owned_domain);
        const owned_from = try allocator.dupe(u8, item.version);
        errdefer allocator.free(owned_from);
        try changes.append(allocator, .{ .domain = owned_domain, .from = owned_from, .to = target });
        target_owned = false;
    }

    if (lock_changed and options.save_lockfile) {
        if (lock) |*l| try lockfile_io.writeLockfile(allocator, l, lock_path);
    }
    return changes.toOwnedSlice(allocator);
}

// ============================================================================
// Tests
// ============================================================================

const TestHooks = struct {
    /// What the registry has for this platform, newest first.
    published: []const []const u8 = &.{"1.5.7.2"},
    domain: ?[]const u8 = "facebook.com/zstd",
    root: []const u8,
    installs: std.ArrayList([]const u8) = .empty,

    fn newestPublished(context: *anyopaque, allocator: std.mem.Allocator, domain: []const u8, range: []const u8) anyerror!?[]u8 {
        const self: *TestHooks = @ptrCast(@alignCast(context));
        if (self.domain) |expected| try std.testing.expectEqualStrings(expected, domain);
        const bound = try semver.parseConstraint(range);
        for (self.published) |version| {
            if (semver.satisfiesConstraint(version, bound)) return try allocator.dupe(u8, version);
        }
        return null;
    }

    fn install(context: *anyopaque, domain: []const u8, version: []const u8) anyerror!void {
        const self: *TestHooks = @ptrCast(@alignCast(context));
        const dir = try std.fmt.allocPrint(std.testing.allocator, "{s}/pantry/{s}/v{s}/bin", .{ self.root, domain, version });
        defer std.testing.allocator.free(dir);
        try io_helper.makePath(dir);
        try self.installs.append(std.testing.allocator, try std.testing.allocator.dupe(u8, version));
    }

    fn hooks(self: *TestHooks) Hooks {
        return .{ .context = self, .newestPublished = newestPublished, .install = install };
    }

    fn deinit(self: *TestHooks) void {
        for (self.installs.items) |v| std.testing.allocator.free(v);
        self.installs.deinit(std.testing.allocator);
    }
};

/// The runner's tree: converged before zstd 1.5.7.2 existed, so pantry.lock
/// pins 1.5.7 and only v1.5.7 is on disk, under packages that depend on it.
fn convergedTree(tmp: *std.testing.TmpDir, buf: []u8) ![]const u8 {
    const len = try tmp.dir.realPath(io_helper.io, buf);
    const root = buf[0..len];
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "deps.yaml", .data = "dependencies:\n  rsync.samba.org: ^3.5.2\n  git-scm.org: ^2.53.0\n" });
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.lock", .data =
        \\{"version":"1.0.0","lockfileVersion":2,"packages":{
        \\"facebook.com/zstd@1.5.7":{"name":"facebook.com/zstd","version":"1.5.7","source":"pantry"},
        \\"rsync.samba.org@3.5.2":{"name":"rsync.samba.org","version":"3.5.2","source":"pantry"},
        \\"lz4.org@1.11.1":{"name":"lz4.org","version":"1.11.1","source":"pantry"}}}
    });
    for ([_][]const u8{ "pantry/facebook.com/zstd/v1.5.7/bin", "pantry/rsync.samba.org/v3.5.2/bin", "pantry/lz4.org/v1.11.1/bin" }) |sub| {
        try tmp.dir.createDirPath(io_helper.io, sub);
    }
    return root;
}

fn lockedVersion(root: []const u8, name: []const u8) !?[]const u8 {
    const path = try std.fs.path.join(std.testing.allocator, &.{ root, "pantry.lock" });
    defer std.testing.allocator.free(path);
    var lock = try lockfile_io.readLockfile(std.testing.allocator, path);
    defer lock.deinit(std.testing.allocator);
    var it = lock.packages.valueIterator();
    var found: ?[]const u8 = null;
    while (it.next()) |entry| {
        if (!std.mem.eql(u8, entry.name, name)) continue;
        if (found != null) return error.TestDuplicateLockEntry;
        found = if (std.mem.eql(u8, entry.version, "1.5.7.2")) "1.5.7.2" else if (std.mem.eql(u8, entry.version, "1.5.7")) "1.5.7" else "other";
    }
    return found;
}

test "build revisions: a locked base build moves to its revision during a named install of satisfied packages" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = try convergedTree(&tmp, &buf);

    // `pantry install rsync.samba.org@3.5.2 git-scm.org@2.53.0`: both already
    // present and satisfied, so nothing would walk down to zstd.
    var hooks = TestHooks{ .root = root };
    defer hooks.deinit();
    const changes = try reconcile(std.testing.allocator, .{
        .project_root = root,
        .exact_pins = &.{ .{ .domain = "rsync.samba.org", .version = "3.5.2" }, .{ .domain = "git-scm.org", .version = "2.53.0" } },
    }, hooks.hooks());
    defer freeChanges(std.testing.allocator, changes);

    try std.testing.expectEqual(@as(usize, 1), changes.len);
    try std.testing.expectEqualStrings("facebook.com/zstd", changes[0].domain);
    try std.testing.expectEqualStrings("1.5.7", changes[0].from);
    try std.testing.expectEqualStrings("1.5.7.2", changes[0].to);
    try std.testing.expectEqual(@as(usize, 1), hooks.installs.items.len);
    try std.testing.expectEqualStrings("1.5.7.2", (try lockedVersion(root, "facebook.com/zstd")).?);
    // Packages without a revision keep their pins.
    try std.testing.expect((try lockedVersion(root, "rsync.samba.org")) != null);

    // A second run has nothing left to do and asks the registry nothing.
    var again = TestHooks{ .root = root, .published = &.{} };
    defer again.deinit();
    const none = try reconcile(std.testing.allocator, .{ .project_root = root }, again.hooks());
    defer freeChanges(std.testing.allocator, none);
    try std.testing.expectEqual(@as(usize, 0), none.len);
}

test "build revisions: an installed base build moves even without a lock" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = try convergedTree(&tmp, &buf);
    try tmp.dir.deleteFile(io_helper.io, "pantry.lock");

    var hooks = TestHooks{ .root = root };
    defer hooks.deinit();
    const changes = try reconcile(std.testing.allocator, .{ .project_root = root }, hooks.hooks());
    defer freeChanges(std.testing.allocator, changes);
    try std.testing.expectEqual(@as(usize, 1), changes.len);
    try std.testing.expectEqualStrings("1.5.7.2", changes[0].to);
}

test "build revisions: an exact pin, an unpublished revision and no-save are respected" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = try convergedTree(&tmp, &buf);

    // `facebook.com/zstd@1.5.7`, written by the user, keeps its own build.
    var pinned = TestHooks{ .root = root };
    defer pinned.deinit();
    const kept = try reconcile(std.testing.allocator, .{ .project_root = root, .exact_pins = &.{.{ .domain = "facebook.com/zstd", .version = "1.5.7" }} }, pinned.hooks());
    defer freeChanges(std.testing.allocator, kept);
    try std.testing.expectEqual(@as(usize, 0), kept.len);
    try std.testing.expectEqual(@as(usize, 0), pinned.installs.items.len);

    // No revision built for this platform yet (1.5.7.1 was darwin-only): stay.
    var unpublished = TestHooks{ .root = root, .published = &.{"1.5.8"} };
    defer unpublished.deinit();
    const stayed = try reconcile(std.testing.allocator, .{ .project_root = root }, unpublished.hooks());
    defer freeChanges(std.testing.allocator, stayed);
    try std.testing.expectEqual(@as(usize, 0), stayed.len);
    try std.testing.expectEqualStrings("1.5.7", (try lockedVersion(root, "facebook.com/zstd")).?);

    // --no-save installs the revision but leaves pantry.lock as it was.
    var unsaved = TestHooks{ .root = root };
    defer unsaved.deinit();
    const moved = try reconcile(std.testing.allocator, .{ .project_root = root, .save_lockfile = false }, unsaved.hooks());
    defer freeChanges(std.testing.allocator, moved);
    try std.testing.expectEqual(@as(usize, 1), moved.len);
    try std.testing.expectEqualStrings("1.5.7", (try lockedVersion(root, "facebook.com/zstd")).?);
}

test "build revisions: a locked prerelease moves to its .pantryN revision, and a stable release does not" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = buf[0..try tmp.dir.realPath(io_helper.io, &buf)];
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.lock", .data =
        \\{"version":"1.0.0","lockfileVersion":2,"packages":{
        \\"libgeos.org@3.15.0rc1":{"name":"libgeos.org","version":"3.15.0rc1","source":"pantry"}}}
    });
    try tmp.dir.createDirPath(io_helper.io, "pantry/libgeos.org/v3.15.0rc1/lib");

    var hooks = TestHooks{ .root = root, .domain = "libgeos.org", .published = &.{ "3.15.0", "3.15.0rc2", "3.15.0rc1.pantry1" } };
    defer hooks.deinit();
    const changes = try reconcile(std.testing.allocator, .{ .project_root = root }, hooks.hooks());
    defer freeChanges(std.testing.allocator, changes);
    // Only the revision of the same release qualifies: never 3.15.0 or rc2.
    try std.testing.expectEqual(@as(usize, 1), changes.len);
    try std.testing.expectEqualStrings("3.15.0rc1.pantry1", changes[0].to);

    const path = try std.fs.path.join(std.testing.allocator, &.{ root, "pantry.lock" });
    defer std.testing.allocator.free(path);
    var lock = try lockfile_io.readLockfile(std.testing.allocator, path);
    defer lock.deinit(std.testing.allocator);
    try std.testing.expect(lock.packages.get("libgeos.org@3.15.0rc1.pantry1") != null);
    try std.testing.expect(lock.packages.get("libgeos.org@3.15.0rc1") == null);
}
