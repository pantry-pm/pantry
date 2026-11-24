//! Replacing installed registry binaries whose artifact was rebuilt in place.
//!
//! The binary registry can overwrite an artifact under its existing version:
//! same `domain@version`, new tarball bytes, a new `sha256`/`size` in
//! `binaries/<domain>/metadata.json`. That is how a broken Linux build is
//! repaired without minting a new version. Nothing on the client noticed. An
//! install skips any version whose `<tree>/<domain>/v<version>` is present,
//! a project install copies a present global copy, and the download cache
//! (keyed by domain@version) handed back the old archive, so the repaired bytes
//! never reached a tree that already had the broken ones.
//!
//! Now every registry binary records the sha256 of the archive it was
//! installed from: a `.pantry-artifact` file in its version directory holding
//! `sha256:<hex>`, and the same string as the `integrity` of its pantry.lock
//! entry (the `sha256:<hex>` form lock integrities already use, see
//! registry/scopes.zig). `reconcile` runs before the install proper: for every
//! locked or installed registry binary it asks the registry for the sha256 of
//! that exact version on this platform (one metadata.json per package, kept
//! for the run by the downloader) and, when it differs from what is installed
//! or locked, reinstalls that version from fresh bytes and rewrites the lock.
//! A matching hash costs that one metadata read and nothing else.
//!
//! `--frozen-lockfile` never installs bytes other than the ones the lock names:
//! a lock hash the registry no longer serves is reported, and nothing changes.

const std = @import("std");
const io_helper = @import("../io_helper.zig");
const generated = @import("../packages/generated.zig");
const lockfile_io = @import("../packages/lockfile.zig");
const pkg_types = @import("../packages/types.zig");

/// The file, in an installed version directory, naming the archive it came from.
pub const marker_name = ".pantry-artifact";

pub const Digest = [32]u8;

/// `sha256:<hex>`: a lock integrity and a marker's contents.
pub const Integrity = [7 + 64]u8;

pub fn formatIntegrity(digest: Digest) Integrity {
    var out: Integrity = undefined;
    @memcpy(out[0..7], "sha256:");
    const hex = std.fmt.bytesToHex(digest, .lower);
    @memcpy(out[7..], &hex);
    return out;
}

/// The digest in a `sha256:<hex>` integrity, or null for anything else (an
/// SRI string, a truncated value) - which is then treated as no record.
pub fn parseIntegrity(text: []const u8) ?Digest {
    const value = std.mem.trim(u8, text, &std.ascii.whitespace);
    if (!std.ascii.startsWithIgnoreCase(value, "sha256:") or value.len != 7 + 64) return null;
    var digest: Digest = undefined;
    _ = std.fmt.hexToBytes(&digest, value[7..]) catch return null;
    return digest;
}

/// The recorded artifact of the version directory `dir`, or null when it has
/// none (installed by an older client, or not from the binary registry).
pub fn readMarker(dir: []const u8) ?Digest {
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/" ++ marker_name, .{dir}) catch return null;
    var content_buf: [256]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&content_buf);
    const content = io_helper.readFileAlloc(fba.allocator(), path, content_buf.len) catch return null;
    return parseIntegrity(content);
}

/// `readMarker` as an owned `sha256:<hex>` string, for a lock entry.
pub fn readMarkerIntegrity(allocator: std.mem.Allocator, dir: []const u8) ?[]const u8 {
    const digest = readMarker(dir) orelse return null;
    const text = formatIntegrity(digest);
    return allocator.dupe(u8, &text) catch null;
}

/// Record that the version directory `dir` holds the archive `digest`.
/// Written beside and renamed over, so a reader never sees half a marker.
pub fn writeMarker(dir: []const u8, digest: Digest) !void {
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buf, "{s}/" ++ marker_name, .{dir});
    var tmp_buf: [std.fs.max_path_bytes]u8 = undefined;
    const tmp = try std.fmt.bufPrint(&tmp_buf, "{s}/" ++ marker_name ++ ".tmp", .{dir});
    {
        const file = try io_helper.createFileAbsolute(tmp, .{ .truncate = true });
        defer io_helper.closeFile(file);
        const text = formatIntegrity(digest);
        try io_helper.writeAllToFile(file, &text);
        try io_helper.writeAllToFile(file, "\n");
    }
    io_helper.rename(tmp, path) catch |err| {
        io_helper.deleteFile(tmp) catch {};
        return err;
    };
}

/// Whether archive bytes are the artifact the registry vouches for. A cached
/// archive is used only when this holds, so a cache filled before the
/// registry replaced an artifact cannot hand back the old bytes.
pub fn archiveMatches(bytes: []const u8, digest: Digest, size: u64) bool {
    if (bytes.len != size) return false;
    var actual: Digest = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &actual, .{});
    return std.mem.eql(u8, &actual, &digest);
}

/// Whether an installed copy elsewhere (the global package dir a project
/// install copies from) may stand in for a fresh download of `expected`.
/// Without a known registry digest nothing changes; with one, only a copy
/// recorded as that same artifact qualifies, and an unrecorded copy is
/// fetched afresh rather than trusted.
pub fn copyMatches(recorded: ?Digest, expected: ?Digest) bool {
    const want = expected orelse return true;
    const have = recorded orelse return false;
    return std.mem.eql(u8, &have, &want);
}

pub const Hooks = struct {
    context: *anyopaque,
    /// The registry's sha256 for exactly `domain@version` on this platform,
    /// or null when the binary registry has no such artifact (or publishes
    /// no checksum for it). An error is a failed lookup and skips the
    /// package. Called from several threads at once.
    registrySha256: *const fn (context: *anyopaque, domain: []const u8, version: []const u8) anyerror!?Digest,
    /// Install exactly `domain@version` from fresh bytes verified against
    /// `digest`, replacing the version directory atomically (its `vN` and
    /// `.bin` links follow, as for any install) and leaving its marker.
    reinstall: *const fn (context: *anyopaque, domain: []const u8, version: []const u8, digest: Digest) anyerror!void,
};

pub const Options = struct {
    /// The directory holding `<domain>/v<version>`: `<project>/pantry`, or a
    /// global `packages` dir.
    tree: []const u8,
    /// The project's pantry.lock; null for a global tree.
    lock_path: ?[]const u8 = null,
    frozen: bool = false,
    /// Write pantry.lock when a hash changed (`--no-save` turns it off).
    save_lockfile: bool = true,
    /// No registry to ask: change nothing.
    offline: bool = false,
    /// Consider only these domains (a global install of named packages).
    only_domains: ?[]const []const u8 = null,
    max_concurrency: usize = 8,
};

pub const Change = struct {
    domain: []const u8,
    version: []const u8,
    /// What was installed or locked; null when nothing was recorded.
    from: ?Digest,
    to: Digest,
    /// The version directory was replaced, not only its lock hash moved.
    reinstalled: bool,
};

/// A frozen lock hash the registry no longer serves for that version.
pub const Mismatch = struct {
    domain: []const u8,
    version: []const u8,
    locked: Digest,
    registry: Digest,
};

pub const Failure = struct {
    domain: []const u8,
    version: []const u8,
    err: anyerror,
};

pub const Report = struct {
    changes: []Change = &.{},
    /// Frozen only. When any is set, nothing was installed or written.
    mismatches: []Mismatch = &.{},
    /// Reinstalls that failed: the installed copy and its lock entry stay
    /// as they were, and the next install tries again.
    failures: []Failure = &.{},

    pub fn deinit(self: Report, allocator: std.mem.Allocator) void {
        for (self.changes) |c| {
            allocator.free(c.domain);
            allocator.free(c.version);
        }
        allocator.free(self.changes);
        for (self.mismatches) |m| {
            allocator.free(m.domain);
            allocator.free(m.version);
        }
        allocator.free(self.mismatches);
        for (self.failures) |f| {
            allocator.free(f.domain);
            allocator.free(f.version);
        }
        allocator.free(self.failures);
    }
};

const Candidate = struct {
    domain: []u8,
    version: []u8,
    lock_key: ?[]u8 = null,
    /// The lock's digest, null when the entry records none we can read.
    locked: ?Digest = null,
    installed: bool = false,
    /// The installed marker; null when installed without one.
    marker: ?Digest = null,
    /// Filled by the registry phase.
    registry: ?Digest = null,

    fn deinit(self: Candidate, allocator: std.mem.Allocator) void {
        allocator.free(self.domain);
        allocator.free(self.version);
        if (self.lock_key) |k| allocator.free(k);
    }
};

/// Registry binaries live under a domain (`zlib.net`, `github.com/google/brotli`).
/// npm packages share the tree and the lock (`zod`, `@scope/pkg`) and are
/// never in the binary registry, so they are not asked about at all.
fn isDomain(name: []const u8) bool {
    if (name.len == 0 or name[0] == '@' or name[0] == '.') return false;
    const first = name[0 .. std.mem.indexOfScalar(u8, name, '/') orelse name.len];
    return std.mem.indexOfScalar(u8, first, '.') != null;
}

fn domainOf(name: []const u8) []const u8 {
    return if (generated.getPackageByName(name)) |pkg| pkg.domain else name;
}

fn isVersionDirName(name: []const u8) bool {
    return name.len >= 2 and name[0] == 'v' and std.ascii.isDigit(name[1]);
}

fn wanted(options: Options, domain: []const u8) bool {
    const only = options.only_domains orelse return true;
    for (only) |d| if (std.mem.eql(u8, domainOf(d), domain)) return true;
    return false;
}

fn find(list: []const Candidate, domain: []const u8, version: []const u8) ?usize {
    for (list, 0..) |c, i| {
        if (std.mem.eql(u8, c.domain, domain) and std.mem.eql(u8, c.version, version)) return i;
    }
    return null;
}

/// Whether `<tree>/<domain>/v<version>` is a real directory (`v1` and `v1.5`
/// are links to one), and its marker.
fn inspectInstalled(allocator: std.mem.Allocator, tree: []const u8, domain: []const u8, version: []const u8) !struct { installed: bool, marker: ?Digest } {
    const dir = try std.fmt.allocPrint(allocator, "{s}/{s}/v{s}", .{ tree, domain, version });
    defer allocator.free(dir);
    const stat = io_helper.cwd().statFile(io_helper.io, dir, .{ .follow_symlinks = false }) catch return .{ .installed = false, .marker = null };
    if (stat.kind != .directory) return .{ .installed = false, .marker = null };
    return .{ .installed = true, .marker = readMarker(dir) };
}

/// Every real version directory under `tree`, to a depth that covers
/// `github.com/<owner>/<repo>`.
fn scanTree(allocator: std.mem.Allocator, options: Options, list: *std.ArrayList(Candidate)) !void {
    var rel: std.ArrayList(u8) = .empty;
    defer rel.deinit(allocator);
    try scanDir(allocator, options, list, &rel, 0);
}

fn scanDir(allocator: std.mem.Allocator, options: Options, list: *std.ArrayList(Candidate), rel: *std.ArrayList(u8), depth: usize) !void {
    const path = if (rel.items.len == 0)
        try allocator.dupe(u8, options.tree)
    else
        try std.fmt.allocPrint(allocator, "{s}/{s}", .{ options.tree, rel.items });
    defer allocator.free(path);
    var dir = io_helper.openDirAbsoluteForIteration(path) catch return;
    defer dir.close();
    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (entry.kind != .directory) continue;
        if (entry.name.len == 0 or entry.name[0] == '.') continue;
        if (depth > 0 and isVersionDirName(entry.name)) {
            const domain = rel.items;
            if (!isDomain(domain) or !wanted(options, domain)) continue;
            const version = entry.name[1..];
            if (find(list.items, domain, version) != null) continue;
            const owned_domain = try allocator.dupe(u8, domain);
            errdefer allocator.free(owned_domain);
            const owned_version = try allocator.dupe(u8, version);
            errdefer allocator.free(owned_version);
            const full = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ path, entry.name });
            defer allocator.free(full);
            try list.append(allocator, .{ .domain = owned_domain, .version = owned_version, .installed = true, .marker = readMarker(full) });
            continue;
        }
        // Only a domain's own path is worth descending: `zlib.net`, then
        // `curl.se/ca-certs`, `github.com/google/brotli`. npm packages
        // (`zod`, which ships `v4/` and `v3/` directories) are not.
        if (depth == 0 and !isDomain(entry.name)) continue;
        if (depth >= 3) continue;
        const mark = rel.items.len;
        if (mark > 0) try rel.append(allocator, '/');
        try rel.appendSlice(allocator, entry.name);
        defer rel.shrinkRetainingCapacity(mark);
        try scanDir(allocator, options, list, rel, depth + 1);
    }
}

const LookupContext = struct {
    hooks: Hooks,
    candidates: []Candidate,
    next: std.atomic.Value(usize) = .init(0),

    fn worker(self: *LookupContext) void {
        while (true) {
            const i = self.next.fetchAdd(1, .monotonic);
            if (i >= self.candidates.len) return;
            const c = &self.candidates[i];
            c.registry = self.hooks.registrySha256(self.hooks.context, c.domain, c.version) catch null;
        }
    }
};

fn lookupAll(candidates: []Candidate, hooks: Hooks, max_concurrency: usize) void {
    var context = LookupContext{ .hooks = hooks, .candidates = candidates };
    const spawn_count = @min(candidates.len, @max(max_concurrency, 1)) -| 1;
    var threads: [32]?std.Thread = @splat(null);
    for (threads[0..@min(spawn_count, threads.len)]) |*t| {
        t.* = std.Thread.spawn(.{}, LookupContext.worker, .{&context}) catch null;
    }
    context.worker();
    for (&threads) |*t| if (t.*) |thread| thread.join();
}

fn eqlDigest(a: Digest, b: Digest) bool {
    return std.mem.eql(u8, &a, &b);
}

/// Bring the tree at `options.tree` (and its pantry.lock) up to the artifacts
/// the registry serves for the versions it already has. Caller frees the
/// report with `deinit`.
pub fn reconcile(allocator: std.mem.Allocator, options: Options, hooks: Hooks) !Report {
    if (options.offline) return .{};

    var candidates: std.ArrayList(Candidate) = .empty;
    defer {
        for (candidates.items) |c| c.deinit(allocator);
        candidates.deinit(allocator);
    }

    var lock: ?pkg_types.Lockfile = if (options.lock_path) |path| lockfile_io.readLockfile(allocator, path) catch null else null;
    defer if (lock) |*l| l.deinit(allocator);

    // Locked binaries first: the lock is what the next install honours.
    if (lock) |*l| {
        var it = l.packages.iterator();
        while (it.next()) |entry| {
            const pkg = entry.value_ptr.*;
            if (pkg.source != .pantry) continue;
            const domain = domainOf(pkg.name);
            if (!isDomain(domain) or !wanted(options, domain)) continue;
            if (find(candidates.items, domain, pkg.version) != null) continue;
            const state = try inspectInstalled(allocator, options.tree, domain, pkg.version);
            const owned_domain = try allocator.dupe(u8, domain);
            errdefer allocator.free(owned_domain);
            const owned_version = try allocator.dupe(u8, pkg.version);
            errdefer allocator.free(owned_version);
            const key = try allocator.dupe(u8, entry.key_ptr.*);
            errdefer allocator.free(key);
            try candidates.append(allocator, .{
                .domain = owned_domain,
                .version = owned_version,
                .lock_key = key,
                .locked = if (pkg.integrity) |i| parseIntegrity(i) else null,
                .installed = state.installed,
                .marker = state.marker,
            });
        }
    }

    // Then binaries that are only on disk: a tree without a lock (or a
    // global tree) is converged too.
    try scanTree(allocator, options, &candidates);

    if (candidates.items.len == 0) return .{};
    lookupAll(candidates.items, hooks, options.max_concurrency);

    var changes: std.ArrayList(Change) = .empty;
    var mismatches: std.ArrayList(Mismatch) = .empty;
    var failures: std.ArrayList(Failure) = .empty;
    errdefer {
        (Report{ .changes = changes.toOwnedSlice(allocator) catch &.{}, .mismatches = mismatches.toOwnedSlice(allocator) catch &.{}, .failures = failures.toOwnedSlice(allocator) catch &.{} }).deinit(allocator);
    }

    // A frozen install installs exactly what the lock names or fails; it
    // decides before touching anything.
    if (options.frozen) {
        for (candidates.items) |c| {
            const registry = c.registry orelse continue;
            const locked = c.locked orelse continue;
            if (eqlDigest(locked, registry)) continue;
            const domain = try allocator.dupe(u8, c.domain);
            errdefer allocator.free(domain);
            const version = try allocator.dupe(u8, c.version);
            errdefer allocator.free(version);
            try mismatches.append(allocator, .{ .domain = domain, .version = version, .locked = locked, .registry = registry });
        }
        if (mismatches.items.len > 0) {
            return .{ .mismatches = try mismatches.toOwnedSlice(allocator) };
        }
    }

    var lock_changed = false;
    for (candidates.items) |*c| {
        const registry = c.registry orelse continue;

        // An installed copy with no marker was installed by a client that
        // recorded nothing, possibly from the very bytes the registry has
        // since replaced, and the archive hash cannot be recovered from an
        // extracted tree. It is reinstalled once: from the download cache
        // when that holds the current archive (checked by sha256), else
        // from the registry. That is the price of letting a runner converged
        // by an older client pick up a repaired artifact on its next
        // install, and from then on the marker makes this a hash compare.
        const stale = c.installed and (if (c.marker) |m| !eqlDigest(m, registry) else true);
        const lock_moves = c.lock_key != null and (if (c.locked) |l| !eqlDigest(l, registry) else true);
        if (!stale and !lock_moves) continue;

        if (stale) {
            hooks.reinstall(hooks.context, c.domain, c.version, registry) catch |err| {
                const domain = try allocator.dupe(u8, c.domain);
                errdefer allocator.free(domain);
                const version = try allocator.dupe(u8, c.version);
                errdefer allocator.free(version);
                try failures.append(allocator, .{ .domain = domain, .version = version, .err = err });
                continue;
            };
        }

        // Frozen: the lock is left as it is (it matches, or names no hash
        // and accepts the first, as lockIntegrityMatches does).
        if (lock_moves and !options.frozen) {
            if (lock) |*l| if (l.packages.getPtr(c.lock_key.?)) |entry| {
                const text = formatIntegrity(registry);
                const owned = try allocator.dupe(u8, &text);
                if (entry.integrity) |old| allocator.free(old);
                entry.integrity = owned;
                lock_changed = true;
            };
        }

        // Only an artifact that really changed, or a copy that had to be
        // replaced, is worth a line; recording a first hash in the lock for
        // bytes already verified is silent.
        // What this tree held: the installed copy's record when there is a
        // copy (null for one an older client installed), else the lock's.
        const from: ?Digest = if (c.installed) c.marker else c.locked;
        const moved = (if (c.locked) |l| !eqlDigest(l, registry) else false);
        if (!stale and !moved) continue;
        const domain = try allocator.dupe(u8, c.domain);
        errdefer allocator.free(domain);
        const version = try allocator.dupe(u8, c.version);
        errdefer allocator.free(version);
        try changes.append(allocator, .{ .domain = domain, .version = version, .from = from, .to = registry, .reinstalled = stale });
    }

    if (lock_changed and options.save_lockfile) {
        if (lock) |*l| try lockfile_io.writeLockfile(allocator, l, options.lock_path.?);
    }
    return .{
        .changes = try changes.toOwnedSlice(allocator),
        .failures = try failures.toOwnedSlice(allocator),
    };
}

// ============================================================================
// Tests
// ============================================================================

const testing = std.testing;

fn digestOf(text: []const u8) Digest {
    var d: Digest = undefined;
    std.crypto.hash.sha2.Sha256.hash(text, &d, .{});
    return d;
}

const old_bytes = "broken linux build";
const new_bytes = "repaired linux build";

const TestHooks = struct {
    root: []const u8,
    /// Whether the registry serves `zlib.net@1.3.1` (the repaired build).
    served: bool = true,
    lookups: std.atomic.Value(usize) = .init(0),
    installs: std.ArrayList([]const u8) = .empty,
    fail_install: bool = false,
    mutex: io_helper.Mutex = .{},

    fn registrySha256(context: *anyopaque, domain: []const u8, version: []const u8) anyerror!?Digest {
        const self: *TestHooks = @ptrCast(@alignCast(context));
        _ = self.lookups.fetchAdd(1, .monotonic);
        if (std.mem.eql(u8, domain, "zlib.net") and std.mem.eql(u8, version, "1.3.1")) return if (self.served) digestOf(new_bytes) else null;
        if (std.mem.eql(u8, domain, "openssl.org")) return digestOf("openssl");
        if (std.mem.eql(u8, domain, "bun.com")) return digestOf("bun");
        return null;
    }

    fn reinstall(context: *anyopaque, domain: []const u8, version: []const u8, digest: Digest) anyerror!void {
        const self: *TestHooks = @ptrCast(@alignCast(context));
        if (self.fail_install) return error.DownloadFailed;
        const dir = try std.fmt.allocPrint(testing.allocator, "{s}/pantry/{s}/v{s}", .{ self.root, domain, version });
        defer testing.allocator.free(dir);
        try io_helper.makePath(dir);
        try writeMarker(dir, digest);
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.installs.append(testing.allocator, try std.fmt.allocPrint(testing.allocator, "{s}@{s}", .{ domain, version }));
    }

    fn hooks(self: *TestHooks) Hooks {
        return .{ .context = self, .registrySha256 = registrySha256, .reinstall = reinstall };
    }

    fn deinit(self: *TestHooks) void {
        for (self.installs.items) |v| testing.allocator.free(v);
        self.installs.deinit(testing.allocator);
    }
};

const Fixture = struct {
    tmp: std.testing.TmpDir,
    buf: [std.fs.max_path_bytes]u8 = undefined,
    root: []const u8 = "",
    tree: []const u8 = "",
    lock_path: []const u8 = "",

    fn init(self: *Fixture, lock_integrity: ?[]const u8, marker: ?Digest) !void {
        self.tmp = std.testing.tmpDir(.{});
        const len = try self.tmp.dir.realPath(io_helper.io, &self.buf);
        self.root = self.buf[0..len];
        self.tree = try std.fmt.allocPrint(testing.allocator, "{s}/pantry", .{self.root});
        self.lock_path = try std.fmt.allocPrint(testing.allocator, "{s}/pantry.lock", .{self.root});
        const integrity_field = if (lock_integrity) |i| try std.fmt.allocPrint(testing.allocator, ",\"integrity\":\"{s}\"", .{i}) else try testing.allocator.dupe(u8, "");
        defer testing.allocator.free(integrity_field);
        const lock = try std.fmt.allocPrint(testing.allocator,
            \\{{"version":"1.0.0","lockfileVersion":2,"packages":{{
            \\"zlib.net@1.3.1":{{"name":"zlib.net","version":"1.3.1","source":"pantry","resolved":"registry:zlib.net@1.3.1"{s}}},
            \\"zod@4.1.0":{{"name":"zod","version":"4.1.0","source":"npm"}}}}}}
        , .{integrity_field});
        defer testing.allocator.free(lock);
        try self.tmp.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.lock", .data = lock });
        try self.tmp.dir.createDirPath(io_helper.io, "pantry/zlib.net/v1.3.1/bin");
        // npm packages share the tree; zod ships `v4/` and `v3/` directories.
        try self.tmp.dir.createDirPath(io_helper.io, "pantry/zod/v4");
        if (marker) |m| {
            const dir = try std.fmt.allocPrint(testing.allocator, "{s}/zlib.net/v1.3.1", .{self.tree});
            defer testing.allocator.free(dir);
            try writeMarker(dir, m);
        }
    }

    fn deinit(self: *Fixture) void {
        testing.allocator.free(self.tree);
        testing.allocator.free(self.lock_path);
        self.tmp.cleanup();
    }

    fn lockedIntegrity(self: *Fixture) !?Digest {
        var lock = try lockfile_io.readLockfile(testing.allocator, self.lock_path);
        defer lock.deinit(testing.allocator);
        const entry = lock.packages.get("zlib.net@1.3.1") orelse return error.TestMissingLockEntry;
        return if (entry.integrity) |i| parseIntegrity(i) else null;
    }

    fn installedMarker(self: *Fixture) ?Digest {
        var buf: [std.fs.max_path_bytes]u8 = undefined;
        const dir = std.fmt.bufPrint(&buf, "{s}/zlib.net/v1.3.1", .{self.tree}) catch return null;
        return readMarker(dir);
    }
};

test "artifact refresh: matching hashes leave the tree and the lock alone, without a download" {
    const served = digestOf(new_bytes);
    const integrity = formatIntegrity(served);
    var f: Fixture = .{ .tmp = undefined };
    try f.init(&integrity, served);
    defer f.deinit();
    const before = try f.tmp.dir.readFileAlloc(io_helper.io, "pantry.lock", testing.allocator, .unlimited);
    defer testing.allocator.free(before);

    var hooks = TestHooks{ .root = f.root };
    defer hooks.deinit();
    const report = try reconcile(testing.allocator, .{ .tree = f.tree, .lock_path = f.lock_path }, hooks.hooks());
    defer report.deinit(testing.allocator);

    try testing.expectEqual(@as(usize, 0), report.changes.len);
    try testing.expectEqual(@as(usize, 0), hooks.installs.items.len);
    // One question about zlib.net; none about zod, an npm package.
    try testing.expectEqual(@as(usize, 1), hooks.lookups.load(.monotonic));
    const after = try f.tmp.dir.readFileAlloc(io_helper.io, "pantry.lock", testing.allocator, .unlimited);
    defer testing.allocator.free(after);
    try testing.expectEqualStrings(before, after);
}

test "artifact refresh: an artifact rebuilt in place is reinstalled and its lock hash rewritten" {
    const old = digestOf(old_bytes);
    const integrity = formatIntegrity(old);
    var f: Fixture = .{ .tmp = undefined };
    try f.init(&integrity, old);
    defer f.deinit();

    var hooks = TestHooks{ .root = f.root };
    defer hooks.deinit();
    const report = try reconcile(testing.allocator, .{ .tree = f.tree, .lock_path = f.lock_path }, hooks.hooks());
    defer report.deinit(testing.allocator);

    try testing.expectEqual(@as(usize, 1), report.changes.len);
    const change = report.changes[0];
    try testing.expectEqualStrings("zlib.net", change.domain);
    try testing.expectEqualStrings("1.3.1", change.version);
    try testing.expect(eqlDigest(change.from.?, old));
    try testing.expect(eqlDigest(change.to, digestOf(new_bytes)));
    try testing.expect(change.reinstalled);
    try testing.expectEqual(@as(usize, 1), hooks.installs.items.len);
    try testing.expectEqualStrings("zlib.net@1.3.1", hooks.installs.items[0]);
    try testing.expect(eqlDigest((try f.lockedIntegrity()).?, digestOf(new_bytes)));
    try testing.expect(eqlDigest(f.installedMarker().?, digestOf(new_bytes)));

    // Converged: the next install compares hashes and does nothing else.
    var again = TestHooks{ .root = f.root };
    defer again.deinit();
    const none = try reconcile(testing.allocator, .{ .tree = f.tree, .lock_path = f.lock_path }, again.hooks());
    defer none.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 0), none.changes.len);
    try testing.expectEqual(@as(usize, 0), again.installs.items.len);
}

test "artifact refresh: a copy an older client installed is fetched once to record its hash" {
    // No marker and no lock hash: everything an older client installed.
    var f: Fixture = .{ .tmp = undefined };
    try f.init(null, null);
    defer f.deinit();

    var hooks = TestHooks{ .root = f.root };
    defer hooks.deinit();
    const report = try reconcile(testing.allocator, .{ .tree = f.tree, .lock_path = f.lock_path }, hooks.hooks());
    defer report.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 1), hooks.installs.items.len);
    try testing.expectEqual(@as(usize, 1), report.changes.len);
    try testing.expect(report.changes[0].from == null);
    try testing.expect(eqlDigest((try f.lockedIntegrity()).?, digestOf(new_bytes)));
    try testing.expect(eqlDigest(f.installedMarker().?, digestOf(new_bytes)));

    // A marker but no lock hash (the lock was written before this client)
    // only records the hash: nothing is downloaded and nothing is reported.
    var g: Fixture = .{ .tmp = undefined };
    try g.init(null, digestOf(new_bytes));
    defer g.deinit();
    var quiet = TestHooks{ .root = g.root };
    defer quiet.deinit();
    const recorded = try reconcile(testing.allocator, .{ .tree = g.tree, .lock_path = g.lock_path }, quiet.hooks());
    defer recorded.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 0), quiet.installs.items.len);
    try testing.expectEqual(@as(usize, 0), recorded.changes.len);
    try testing.expect(eqlDigest((try g.lockedIntegrity()).?, digestOf(new_bytes)));
}

test "artifact refresh: a frozen lock whose hash the registry no longer serves fails and changes nothing" {
    const old = digestOf(old_bytes);
    const integrity = formatIntegrity(old);
    var f: Fixture = .{ .tmp = undefined };
    try f.init(&integrity, old);
    defer f.deinit();

    var hooks = TestHooks{ .root = f.root };
    defer hooks.deinit();
    const report = try reconcile(testing.allocator, .{ .tree = f.tree, .lock_path = f.lock_path, .frozen = true }, hooks.hooks());
    defer report.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 1), report.mismatches.len);
    try testing.expectEqualStrings("zlib.net", report.mismatches[0].domain);
    try testing.expectEqualStrings("1.3.1", report.mismatches[0].version);
    try testing.expect(eqlDigest(report.mismatches[0].locked, old));
    try testing.expect(eqlDigest(report.mismatches[0].registry, digestOf(new_bytes)));
    try testing.expectEqual(@as(usize, 0), hooks.installs.items.len);
    try testing.expect(eqlDigest((try f.lockedIntegrity()).?, old));
    try testing.expect(eqlDigest(f.installedMarker().?, old));

    // A frozen lock that names the served bytes over a stale copy brings the
    // copy to the lock, and leaves the lock as it is.
    const served = formatIntegrity(digestOf(new_bytes));
    var g: Fixture = .{ .tmp = undefined };
    try g.init(&served, old);
    defer g.deinit();
    var repair = TestHooks{ .root = g.root };
    defer repair.deinit();
    const repaired = try reconcile(testing.allocator, .{ .tree = g.tree, .lock_path = g.lock_path, .frozen = true }, repair.hooks());
    defer repaired.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 0), repaired.mismatches.len);
    try testing.expectEqual(@as(usize, 1), repair.installs.items.len);
    try testing.expect(eqlDigest(g.installedMarker().?, digestOf(new_bytes)));
}

test "artifact refresh: offline, unknown to the registry, or a failed reinstall changes nothing" {
    const old = digestOf(old_bytes);
    const integrity = formatIntegrity(old);
    var f: Fixture = .{ .tmp = undefined };
    try f.init(&integrity, old);
    defer f.deinit();

    var offline = TestHooks{ .root = f.root };
    defer offline.deinit();
    const skipped = try reconcile(testing.allocator, .{ .tree = f.tree, .lock_path = f.lock_path, .offline = true }, offline.hooks());
    defer skipped.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 0), offline.lookups.load(.monotonic));
    try testing.expectEqual(@as(usize, 0), skipped.changes.len);

    var unknown = TestHooks{ .root = f.root, .served = false };
    defer unknown.deinit();
    const none = try reconcile(testing.allocator, .{ .tree = f.tree, .lock_path = f.lock_path }, unknown.hooks());
    defer none.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 0), none.changes.len);
    try testing.expectEqual(@as(usize, 0), unknown.installs.items.len);

    var failing = TestHooks{ .root = f.root, .fail_install = true };
    defer failing.deinit();
    const failed = try reconcile(testing.allocator, .{ .tree = f.tree, .lock_path = f.lock_path }, failing.hooks());
    defer failed.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 1), failed.failures.len);
    try testing.expectEqual(@as(usize, 0), failed.changes.len);
    // The lock keeps naming what is actually installed.
    try testing.expect(eqlDigest((try f.lockedIntegrity()).?, old));
}

test "artifact refresh: a global tree without a lock, limited to the named packages" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = buf[0..try tmp.dir.realPath(io_helper.io, &buf)];
    try tmp.dir.createDirPath(io_helper.io, "pantry/zlib.net/v1.3.1/bin");
    try tmp.dir.createDirPath(io_helper.io, "pantry/openssl.org/v3.6.0/lib");
    try tmp.dir.createDirPath(io_helper.io, "pantry/npm/left-pad/1.3.0");
    const tree = try std.fmt.allocPrint(testing.allocator, "{s}/pantry", .{root});
    defer testing.allocator.free(tree);

    var hooks = TestHooks{ .root = root };
    defer hooks.deinit();
    const report = try reconcile(testing.allocator, .{ .tree = tree, .only_domains = &.{"zlib.net"} }, hooks.hooks());
    defer report.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 1), hooks.installs.items.len);
    try testing.expectEqualStrings("zlib.net@1.3.1", hooks.installs.items[0]);
    try testing.expectEqual(@as(usize, 1), hooks.lookups.load(.monotonic));

    // Unfiltered, nested domains are found too, and npm's tree is not.
    try tmp.dir.createDirPath(io_helper.io, "pantry/github.com/google/brotli/v1.2.0/lib");
    var all = TestHooks{ .root = root };
    defer all.deinit();
    const everything = try reconcile(testing.allocator, .{ .tree = tree }, all.hooks());
    defer everything.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 3), all.lookups.load(.monotonic));
    // openssl.org had no marker; zlib.net now has the right one.
    try testing.expectEqual(@as(usize, 1), all.installs.items.len);
    try testing.expectEqualStrings("openssl.org@3.6.0", all.installs.items[0]);
}

test "artifact refresh: a lock that names a package by an older name checks the domain it installed under" {
    // pantry.lock says `bun.sh`; the catalog's domain, and the tree's, is bun.com.
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = buf[0..try tmp.dir.realPath(io_helper.io, &buf)];
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.lock", .data =
        \\{"version":"1.0","packages":{"bun.sh@1.4.3":{"name":"bun.sh","version":"1.4.3","resolved":"registry:bun.sh@1.4.3"}}}
    });
    try tmp.dir.createDirPath(io_helper.io, "pantry/bun.com/v1.4.3/bin");
    const tree = try std.fmt.allocPrint(testing.allocator, "{s}/pantry", .{root});
    defer testing.allocator.free(tree);
    const lock_path = try std.fmt.allocPrint(testing.allocator, "{s}/pantry.lock", .{root});
    defer testing.allocator.free(lock_path);
    const installed = try std.fmt.allocPrint(testing.allocator, "{s}/bun.com/v1.4.3", .{tree});
    defer testing.allocator.free(installed);
    try writeMarker(installed, digestOf("bun"));

    var hooks = TestHooks{ .root = root };
    defer hooks.deinit();
    const report = try reconcile(testing.allocator, .{ .tree = tree, .lock_path = lock_path }, hooks.hooks());
    defer report.deinit(testing.allocator);
    // One lookup (bun.com, not bun.sh as well), nothing to replace, and the
    // hash recorded under the lock's own key.
    try testing.expectEqual(@as(usize, 1), hooks.lookups.load(.monotonic));
    try testing.expectEqual(@as(usize, 0), hooks.installs.items.len);
    var lock = try lockfile_io.readLockfile(testing.allocator, lock_path);
    defer lock.deinit(testing.allocator);
    try testing.expect(eqlDigest(parseIntegrity(lock.packages.get("bun.sh@1.4.3").?.integrity.?).?, digestOf("bun")));
}

test "artifact refresh: a copy without a marker under a locked hash is re-fetched, not reported as rebuilt" {
    const served = formatIntegrity(digestOf(new_bytes));
    var f: Fixture = .{ .tmp = undefined };
    try f.init(&served, null);
    defer f.deinit();
    var hooks = TestHooks{ .root = f.root };
    defer hooks.deinit();
    const report = try reconcile(testing.allocator, .{ .tree = f.tree, .lock_path = f.lock_path }, hooks.hooks());
    defer report.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 1), hooks.installs.items.len);
    try testing.expectEqual(@as(usize, 1), report.changes.len);
    try testing.expect(report.changes[0].from == null);
}

test "artifact refresh: integrity strings, cached archives and shared copies" {
    const d = digestOf(new_bytes);
    const text = formatIntegrity(d);
    try testing.expect(std.mem.startsWith(u8, &text, "sha256:"));
    try testing.expect(eqlDigest(parseIntegrity(&text).?, d));
    try testing.expect(parseIntegrity("sha512-abc") == null);
    try testing.expect(parseIntegrity("sha256:abc") == null);

    try testing.expect(archiveMatches(new_bytes, d, new_bytes.len));
    try testing.expect(!archiveMatches(old_bytes, d, old_bytes.len));
    try testing.expect(!archiveMatches(new_bytes, d, new_bytes.len + 1));

    try testing.expect(copyMatches(null, null));
    try testing.expect(copyMatches(digestOf(old_bytes), null));
    try testing.expect(copyMatches(d, d));
    try testing.expect(!copyMatches(digestOf(old_bytes), d));
    try testing.expect(!copyMatches(null, d));
}
