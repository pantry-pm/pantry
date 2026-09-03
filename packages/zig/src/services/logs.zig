//! Service log retention.
//!
//! Every generated unit points its stdout/stderr at
//! `~/.local/share/pantry/logs/[<project>/]<service>.{log,err}`, and nothing
//! used to bound those files. A service that comes up healthy writes a few
//! KB a day and the absence of a cap never shows; a service that *cannot*
//! come up is a different shape entirely. `keep_alive` restarts it, it logs
//! its whole startup and shutdown banner, it dies, and launchd starts it
//! again ten seconds later — forever, with no human in the loop because the
//! project it belongs to is one the developer stopped using.
//!
//! That is not hypothetical: a typesense whose peering port was already held
//! by another project's typesense wrote **78 GB** into a single
//! `typesense.log` this way. Its raft layer re-logs the group configuration
//! once per term on shutdown, and the term counter is the restart count, so
//! each restart cost more than the last — a crash loop that grows
//! quadratically. By the time it was noticed the logs directory was 84 GB.
//!
//! So: cap the files, and cap them from inside pantry rather than by
//! recommending `newsyslog`/`logrotate` in a doc nobody reads.

const std = @import("std");
const io_helper = @import("../io_helper.zig");

/// Per-file retention policy.
pub const Policy = struct {
    /// Rotate a log once it exceeds this. 10 MiB is well past what a healthy
    /// service writes between rotations and still cheap to `tail`.
    max_bytes: u64 = 10 * 1024 * 1024,
    /// Rotated generations to keep (`<name>.log.1` … `.N`). The live file
    /// plus its generations is the worst case per log, so the default caps a
    /// single service at ~20 MiB.
    keep: u8 = 1,

    /// Env overrides, for the developer who wants more history (or none):
    ///   PANTRY_LOG_MAX_MB=50   PANTRY_LOG_KEEP=3
    /// `PANTRY_LOG_MAX_MB=0` disables rotation entirely.
    pub fn fromEnv(allocator: std.mem.Allocator) Policy {
        var policy = Policy{};

        if (io_helper.getEnvVarOwned(allocator, "PANTRY_LOG_MAX_MB") catch null) |raw| {
            defer allocator.free(raw);
            const trimmed = std.mem.trim(u8, raw, " \t\r\n");
            if (std.fmt.parseInt(u64, trimmed, 10)) |mb| {
                policy.max_bytes = mb * 1024 * 1024;
            } else |_| {}
        }

        if (io_helper.getEnvVarOwned(allocator, "PANTRY_LOG_KEEP") catch null) |raw| {
            defer allocator.free(raw);
            const trimmed = std.mem.trim(u8, raw, " \t\r\n");
            if (std.fmt.parseInt(u8, trimmed, 10)) |keep| {
                policy.keep = keep;
            } else |_| {}
        }

        return policy;
    }

    pub fn disabled(self: Policy) bool {
        return self.max_bytes == 0;
    }
};

pub const Summary = struct {
    files_rotated: usize = 0,
    bytes_reclaimed: u64 = 0,

    pub fn merge(self: *Summary, other: Summary) void {
        self.files_rotated += other.files_rotated;
        self.bytes_reclaimed += other.bytes_reclaimed;
    }
};

/// `~/.local/share/pantry/logs`, caller-owned. Null when HOME is unset.
pub fn logsRoot(allocator: std.mem.Allocator) ?[]u8 {
    const home = io_helper.getEnvVarOwned(allocator, "HOME") catch return null;
    defer allocator.free(home);
    return std.fmt.allocPrint(allocator, "{s}/.local/share/pantry/logs", .{home}) catch null;
}

/// Directory holding one service's logs — project-scoped when the service is.
pub fn logsDir(allocator: std.mem.Allocator, project_id: ?[]const u8) ?[]u8 {
    const root = logsRoot(allocator) orelse return null;
    const pid = project_id orelse return root;
    defer allocator.free(root);
    return std.fmt.allocPrint(allocator, "{s}/{s}", .{ root, pid }) catch null;
}

const copy_chunk = 1024 * 1024;

/// Copy the last `len` bytes of `src` into a fresh `dest`.
fn copyTail(allocator: std.mem.Allocator, src: []const u8, dest: []const u8, len: u64) !void {
    const stat = try io_helper.statFile(src);
    const start = if (stat.size > len) stat.size - len else 0;

    const in = try io_helper.openFile(src, .{ .mode = .read_only });
    defer io_helper.closeFile(in);
    try io_helper.seekFromStart(in, start);

    const out = try io_helper.createFile(dest, .{});
    defer io_helper.closeFile(out);

    const buf = try allocator.alloc(u8, copy_chunk);
    defer allocator.free(buf);

    while (true) {
        const n = io_helper.platformRead(in.handle, buf) catch break;
        if (n == 0) break;
        try io_helper.writeAllToFile(out, buf[0..n]);
    }
}

/// Rotate one log file if it has outgrown the policy.
///
/// The live file is truncated in place rather than renamed, because the
/// service writing to it holds an open descriptor (see
/// `io_helper.truncateFile`). What would be a rename elsewhere is a
/// copy-then-truncate here.
///
/// Only the last `max_bytes` are carried into `.1`. For a file caught at the
/// threshold that is all of it; for one that ran away between checks — the
/// 78 GB case — it keeps the recent, diagnostic end and drops the repetition
/// ahead of it. Either way the pair is bounded, which is the property that
/// was missing.
pub fn rotateFile(allocator: std.mem.Allocator, path: []const u8, policy: Policy) Summary {
    if (policy.disabled()) return .{};

    const stat = io_helper.statFile(path) catch return .{};
    if (stat.size <= policy.max_bytes) return .{};

    // Age out existing generations, oldest first: .2 -> .3, .1 -> .2, …
    if (policy.keep > 0) {
        var gen: u8 = policy.keep;
        while (gen > 1) : (gen -= 1) {
            const older = std.fmt.allocPrint(allocator, "{s}.{d}", .{ path, gen }) catch continue;
            defer allocator.free(older);
            const newer = std.fmt.allocPrint(allocator, "{s}.{d}", .{ path, gen - 1 }) catch continue;
            defer allocator.free(newer);
            io_helper.deleteFile(older) catch {};
            io_helper.rename(newer, older) catch {};
        }

        const first = std.fmt.allocPrint(allocator, "{s}.1", .{path}) catch return .{};
        defer allocator.free(first);
        copyTail(allocator, path, first, policy.max_bytes) catch {
            // A generation we could not write is not a reason to keep the
            // live file growing — the cap matters more than the history.
        };
    }

    // Drop anything past `keep`, including generations left by a previously
    // more generous PANTRY_LOG_KEEP.
    var gen: u16 = @as(u16, policy.keep) + 1;
    while (gen <= 32) : (gen += 1) {
        const stale = std.fmt.allocPrint(allocator, "{s}.{d}", .{ path, gen }) catch break;
        defer allocator.free(stale);
        io_helper.deleteFile(stale) catch {};
    }

    io_helper.truncateFile(path, 0) catch return .{};
    return .{ .files_rotated = 1, .bytes_reclaimed = stat.size };
}

/// Rotate both streams of one service. Called on every start/restart, where
/// nothing holds the file open yet and rotation is free.
pub fn rotateService(
    allocator: std.mem.Allocator,
    service_name: []const u8,
    project_id: ?[]const u8,
    policy: Policy,
) Summary {
    var summary = Summary{};
    if (policy.disabled()) return summary;

    const dir = logsDir(allocator, project_id) orelse return summary;
    defer allocator.free(dir);

    for ([_][]const u8{ "log", "err" }) |ext| {
        const path = std.fmt.allocPrint(allocator, "{s}/{s}.{s}", .{ dir, service_name, ext }) catch continue;
        defer allocator.free(path);
        summary.merge(rotateFile(allocator, path, policy));
    }

    return summary;
}

fn isLogFile(name: []const u8) bool {
    return std.mem.endsWith(u8, name, ".log") or std.mem.endsWith(u8, name, ".err");
}

fn rotateDir(allocator: std.mem.Allocator, dir_path: []const u8, policy: Policy, depth: u8) Summary {
    var summary = Summary{};

    var dir = io_helper.openDirForIteration(dir_path) catch return summary;
    defer dir.close();

    var iter = dir.iterate();
    while (iter.next() catch null) |entry| {
        const child = std.fmt.allocPrint(allocator, "{s}/{s}", .{ dir_path, entry.name }) catch continue;
        defer allocator.free(child);

        // The directory entry's own kind, not `statFile`'s: that helper opens
        // the path and reports `.file` for anything it can open, and on macOS
        // a directory opens fine. Trusting it here skipped every
        // project-scoped subdirectory — which is where all the logs are.
        if (entry.kind == .directory) {
            // One level of project-scoped subdirectories is all the layout has.
            if (depth == 0) summary.merge(rotateDir(allocator, child, policy, depth + 1));
            continue;
        }
        if (!isLogFile(entry.name)) continue;
        summary.merge(rotateFile(allocator, child, policy));
    }

    return summary;
}

/// Sweep the whole logs tree — every project, every service, including ones
/// whose unit is long gone. This is what `pantry logs --prune` runs,
/// and what any command that touches services can call cheaply: a stat per
/// file, work only where a file is over the cap.
pub fn rotateAll(allocator: std.mem.Allocator, policy: Policy) Summary {
    if (policy.disabled()) return .{};
    const root = logsRoot(allocator) orelse return .{};
    defer allocator.free(root);
    return rotateDir(allocator, root, policy, 0);
}

test "policy disabled only at zero" {
    try std.testing.expect(!(Policy{}).disabled());
    try std.testing.expect((Policy{ .max_bytes = 0 }).disabled());
}

test "rotateFile leaves a file under the cap alone" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const dir_path = path_buf[0..try tmp.dir.realPath(io_helper.io, &path_buf)];

    const path = try std.fmt.allocPrint(allocator, "{s}/small.log", .{dir_path});
    defer allocator.free(path);

    {
        const f = try io_helper.createFile(path, .{});
        defer io_helper.closeFile(f);
        try io_helper.writeAllToFile(f, "still small\n");
    }

    const summary = rotateFile(allocator, path, .{ .max_bytes = 1024 });
    try std.testing.expectEqual(@as(usize, 0), summary.files_rotated);

    const stat = try io_helper.statFile(path);
    try std.testing.expectEqual(@as(u64, "still small\n".len), stat.size);
}

test "rotateFile truncates in place and keeps a generation" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const dir_path = path_buf[0..try tmp.dir.realPath(io_helper.io, &path_buf)];

    const path = try std.fmt.allocPrint(allocator, "{s}/big.log", .{dir_path});
    defer allocator.free(path);

    {
        const f = try io_helper.createFile(path, .{});
        defer io_helper.closeFile(f);
        var i: usize = 0;
        while (i < 400) : (i += 1) try io_helper.writeAllToFile(f, "0123456789");
    }

    // The inode must survive: a running service holds this descriptor.
    const before = try io_helper.statFile(path);
    const summary = rotateFile(allocator, path, .{ .max_bytes = 1000, .keep = 1 });

    try std.testing.expectEqual(@as(usize, 1), summary.files_rotated);
    try std.testing.expectEqual(before.size, summary.bytes_reclaimed);

    const after = try io_helper.statFile(path);
    try std.testing.expectEqual(@as(u64, 0), after.size);

    const rotated = try std.fmt.allocPrint(allocator, "{s}.1", .{path});
    defer allocator.free(rotated);
    const rotated_stat = try io_helper.statFile(rotated);
    try std.testing.expectEqual(@as(u64, 1000), rotated_stat.size);
}

test "rotateFile carries the tail, not the head" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const dir_path = path_buf[0..try tmp.dir.realPath(io_helper.io, &path_buf)];

    const path = try std.fmt.allocPrint(allocator, "{s}/tail.log", .{dir_path});
    defer allocator.free(path);

    {
        const f = try io_helper.createFile(path, .{});
        defer io_helper.closeFile(f);
        try io_helper.writeAllToFile(f, "OLDEST");
        var i: usize = 0;
        while (i < 100) : (i += 1) try io_helper.writeAllToFile(f, "xxxxxxxxxx");
        try io_helper.writeAllToFile(f, "NEWEST");
    }

    _ = rotateFile(allocator, path, .{ .max_bytes = 64, .keep = 1 });

    const rotated = try std.fmt.allocPrint(allocator, "{s}.1", .{path});
    defer allocator.free(rotated);
    const kept = try io_helper.readFileAllocAbsolute(allocator, rotated, 1024);
    defer allocator.free(kept);

    try std.testing.expect(std.mem.endsWith(u8, kept, "NEWEST"));
    try std.testing.expect(std.mem.indexOf(u8, kept, "OLDEST") == null);
}

test "rotateFile prunes generations beyond keep" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const dir_path = path_buf[0..try tmp.dir.realPath(io_helper.io, &path_buf)];

    const path = try std.fmt.allocPrint(allocator, "{s}/gen.log", .{dir_path});
    defer allocator.free(path);

    {
        const f = try io_helper.createFile(path, .{});
        defer io_helper.closeFile(f);
        var i: usize = 0;
        while (i < 200) : (i += 1) try io_helper.writeAllToFile(f, "0123456789");
    }
    // A leftover from a more generous PANTRY_LOG_KEEP.
    const stale = try std.fmt.allocPrint(allocator, "{s}.3", .{path});
    defer allocator.free(stale);
    {
        const f = try io_helper.createFile(stale, .{});
        defer io_helper.closeFile(f);
        try io_helper.writeAllToFile(f, "ancient");
    }

    _ = rotateFile(allocator, path, .{ .max_bytes = 100, .keep = 1 });

    try std.testing.expectError(error.FileNotFound, io_helper.statFile(stale));
}

test "rotateFile is a no-op when the policy is disabled" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const dir_path = path_buf[0..try tmp.dir.realPath(io_helper.io, &path_buf)];

    const path = try std.fmt.allocPrint(allocator, "{s}/off.log", .{dir_path});
    defer allocator.free(path);

    {
        const f = try io_helper.createFile(path, .{});
        defer io_helper.closeFile(f);
        var i: usize = 0;
        while (i < 200) : (i += 1) try io_helper.writeAllToFile(f, "0123456789");
    }

    const summary = rotateFile(allocator, path, .{ .max_bytes = 0 });
    try std.testing.expectEqual(@as(usize, 0), summary.files_rotated);

    const stat = try io_helper.statFile(path);
    try std.testing.expectEqual(@as(u64, 2000), stat.size);
}
