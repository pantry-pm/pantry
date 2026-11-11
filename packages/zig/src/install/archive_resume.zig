//! Quarantined native archives. A partial is never an installed package: the
//! resolver's complete size and SHA-256 must match before bytes leave here.
const std = @import("std");
const builtin = @import("builtin");
const io = @import("../io_helper.zig");

pub const Identity = struct { sha256: [32]u8, size: u64 };
pub const Options = struct {
    timeout_ms: u64 = 300_000,
    max_attempts: u32 = 3,
    retry_delay_ms: u64 = 1000,
};
const header_size = 320;
const magic = "PNTRYRP1";
const max_archive_size: u64 = 4 * 1024 * 1024 * 1024;
const max_reserved_bytes: u64 = 8 * 1024 * 1024 * 1024;
const max_entries = 64;
const expiry_ns: i128 = 2 * 24 * 60 * 60 * std.time.ns_per_s;

pub fn download(allocator: std.mem.Allocator, url: []const u8, destination: []const u8, identity: Identity, cache_root: []const u8, options: Options) !void {
    if (identity.size == 0 or identity.size > max_archive_size or options.max_attempts == 0) return error.InvalidDownloadOptions;
    return io.runWithTimeout(run, .{ allocator, url, destination, identity, cache_root, options }, options.timeout_ms);
}

fn openLocked(directory: std.Io.Dir, name: []const u8, create: bool, nonblocking: bool) !std.Io.File {
    const file = if (create)
        directory.createFile(io.io, name, .{ .read = true, .truncate = false, .exclusive = true, .lock = .exclusive, .lock_nonblocking = nonblocking, .permissions = if (builtin.os.tag == .windows) .default_file else .fromMode(0o600) }) catch |err| switch (err) {
            error.PathAlreadyExists => try directory.openFile(io.io, name, .{ .mode = .read_write, .follow_symlinks = false, .lock = .exclusive, .lock_nonblocking = nonblocking }),
            else => return err,
        }
    else
        try directory.openFile(io.io, name, .{ .mode = .read_write, .follow_symlinks = false, .lock = .exclusive, .lock_nonblocking = nonblocking });
    errdefer file.close(io.io);
    const stat = try file.stat(io.io);
    if (stat.kind != .file or stat.nlink != 1 or (builtin.os.tag != .windows and stat.permissions.toMode() & 0o777 != 0o600)) return error.UnsafePartialArchive;
    return file;
}

fn identityHeader(identity: Identity) [header_size]u8 {
    var header: [header_size]u8 = @splat(0);
    @memcpy(header[0..8], magic);
    @memcpy(header[8..40], &identity.sha256);
    std.mem.writeInt(u64, header[40..48], identity.size, .little);
    return header;
}

fn headerMatches(header: []const u8, identity: Identity) bool {
    return header.len == header_size and std.mem.eql(u8, header[0..8], magic) and std.mem.eql(u8, header[8..40], &identity.sha256) and std.mem.readInt(u64, header[40..48], .little) == identity.size;
}

fn cacheKey(url: []const u8, identity: Identity) [64]u8 {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    hash.update(url);
    hash.update(&identity.sha256);
    var size: [8]u8 = undefined;
    std.mem.writeInt(u64, &size, identity.size, .little);
    hash.update(&size);
    var digest: [32]u8 = undefined;
    hash.final(&digest);
    return std.fmt.bytesToHex(digest, .lower);
}

/// Admission counts reservations, not just bytes downloaded so far. Every
/// entrant takes this same lock before creating a partial, including processes
/// that later die. Data-file locks are nonblocking; expired active entries are
/// never removed and there are no waiters on an inode we unlink.
fn admit(directory: std.Io.Dir, key: []const u8, identity: Identity) !std.Io.File {
    const quota = try openLocked(directory, "quota.lock", true, false);
    defer quota.close(io.io);
    var entries = directory.iterate();
    var reserved: u64 = 0;
    var count: usize = 0;
    var visited: usize = 0;
    var existing = false;
    while (try entries.next(io.io)) |entry| {
        visited += 1;
        if (visited > max_entries + 1) return error.PartialArchiveCacheFull;
        if (!std.mem.endsWith(u8, entry.name, ".partial")) continue;
        const candidate = openLocked(directory, entry.name, false, true) catch |err| switch (err) {
            // The immutable reservation is also in its name. Windows locks
            // prevent reading another handle's locked bytes, so accounting
            // must not open or read an active downloader's data file.
            error.WouldBlock => {
                const end = std.mem.indexOfScalar(u8, entry.name, '-') orelse 0;
                const size = std.fmt.parseInt(u64, entry.name[0..end], 10) catch max_archive_size;
                reserved +|= if (size > 0 and size <= max_archive_size) size else max_archive_size;
                count += 1;
                continue;
            },
            error.FileNotFound => continue,
            else => return err,
        };
        defer candidate.close(io.io);
        const stat = try candidate.stat(io.io);
        var header: [header_size]u8 = undefined;
        const length = try candidate.readPositionalAll(io.io, &header, 0);
        const valid = length == header_size and std.mem.eql(u8, header[0..8], magic);
        const size = if (valid) std.mem.readInt(u64, header[40..48], .little) else 0;
        const expired = @as(i128, io.getMilliTimestamp()) * std.time.ns_per_ms - stat.mtime.nanoseconds > expiry_ns;
        if (!valid or size == 0 or size > max_archive_size or stat.size > size + header_size or expired) {
            try directory.deleteFile(io.io, entry.name);
            continue;
        }
        reserved +|= size;
        count += 1;
        if (std.mem.eql(u8, entry.name, key)) existing = true;
    }
    if (!existing and (count >= max_entries or reserved > max_reserved_bytes - identity.size)) return error.PartialArchiveCacheFull;
    const file = try openLocked(directory, key, true, true);
    errdefer file.close(io.io);
    const stat = try file.stat(io.io);
    var header: [header_size]u8 = undefined;
    const length = try file.readPositionalAll(io.io, &header, 0);
    if (!headerMatches(header[0..length], identity) or stat.size > identity.size + header_size) {
        try file.setLength(io.io, 0);
        try file.writePositionalAll(io.io, &identityHeader(identity), 0);
    }
    return file;
}

fn responseHeader(stream: *io.HttpStream, name: []const u8) ?[]const u8 {
    var headers = stream.response.head.iterateHeaders();
    while (headers.next()) |header| if (std.ascii.eqlIgnoreCase(header.name, name)) return header.value;
    return null;
}

fn strongEtag(value: []const u8) bool {
    if (value.len < 2 or value.len > 256 or value[0] != '"' or value[value.len - 1] != '"') return false;
    for (value[1 .. value.len - 1]) |byte| if (byte < 0x21 or byte == '"' or byte == 0x7f) return false;
    return true;
}

fn validRange(value: []const u8, offset: u64, size: u64) bool {
    if (!std.mem.startsWith(u8, value, "bytes ")) return false;
    const dash = std.mem.indexOfScalar(u8, value, '-') orelse return false;
    const slash = std.mem.indexOfScalar(u8, value, '/') orelse return false;
    if (dash < 6 or slash <= dash + 1) return false;
    const start = std.fmt.parseInt(u64, value[6..dash], 10) catch return false;
    const end = std.fmt.parseInt(u64, value[dash + 1 .. slash], 10) catch return false;
    const total = std.fmt.parseInt(u64, value[slash + 1 ..], 10) catch return false;
    return start == offset and total == size and end == size - 1;
}

fn attempt(allocator: std.mem.Allocator, url: []const u8, file: std.Io.File, identity: Identity, budget: *io.HttpGetRetryBudget) !void {
    var header: [header_size]u8 = undefined;
    if (try file.readPositionalAll(io.io, &header, 0) != header_size) return error.InvalidPartialArchive;
    const etag_length = std.mem.readInt(u16, header[48..50], .little);
    const stored_etag = header[50 .. 50 + @min(etag_length, 256)];
    var offset = (try file.stat(io.io)).size - header_size;
    if (offset == identity.size) return;
    if (offset > 0 and (etag_length > 256 or !strongEtag(stored_etag))) {
        try file.setLength(io.io, header_size);
        offset = 0;
    }
    if (offset > 0) @import("../cli/style.zig").print("  Resuming verified archive at {d}/{d} bytes\n", .{ offset, identity.size });
    const stream = if (offset > 0)
        try io.httpStreamGetRange(allocator, url, budget, offset, stored_etag)
    else
        try io.httpStreamGetWithRetryBudget(allocator, url, budget);
    defer stream.deinit();
    const status = @backingInt(stream.response.head.status);
    if (status == 206) {
        if (!validRange(responseHeader(stream, "Content-Range") orelse "", offset, identity.size) or !std.mem.eql(u8, responseHeader(stream, "ETag") orelse "", stored_etag)) {
            try file.setLength(io.io, header_size);
            return error.InvalidArchiveRange;
        }
    } else if (status == 200) {
        try file.setLength(io.io, header_size);
        offset = 0;
        const etag = responseHeader(stream, "ETag") orelse "";
        @memset(header[48..], 0);
        if (strongEtag(etag)) {
            std.mem.writeInt(u16, header[48..50], @intCast(etag.len), .little);
            @memcpy(header[50 .. 50 + etag.len], etag);
        }
        try file.writePositionalAll(io.io, header[48..], 48);
    } else {
        try file.setLength(io.io, header_size);
        return error.InvalidArchiveRange;
    }
    if (stream.contentLength()) |length| if (length != identity.size - offset) return error.InvalidArchiveLength;
    var transfer: [65536]u8 = undefined;
    const reader = stream.reader(&transfer);
    var bytes: [65536]u8 = undefined;
    while (true) {
        var buffers = [_][]u8{&bytes};
        const length = reader.readVec(&buffers) catch |err| switch (err) {
            error.EndOfStream => break,
            else => return stream.readError(err),
        };
        if (length == 0) continue;
        if (length > identity.size - offset) {
            try file.setLength(io.io, header_size);
            return error.InvalidArchiveLength;
        }
        try file.writePositionalAll(io.io, bytes[0..length], header_size + offset);
        offset += length;
    }
    if (offset != identity.size) return error.IncompleteDownload;
}

fn verify(file: std.Io.File, identity: Identity, data_offset: u64) !void {
    if ((try file.stat(io.io)).size != identity.size + data_offset) return error.InvalidArchiveLength;
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    var buffer: [65536]u8 = undefined;
    var offset: u64 = 0;
    while (offset < identity.size) {
        const length = try file.readPositionalAll(io.io, buffer[0..@intCast(@min(buffer.len, identity.size - offset))], data_offset + offset);
        if (length == 0) return error.IncompleteDownload;
        hash.update(buffer[0..length]);
        offset += length;
    }
    var digest: [32]u8 = undefined;
    hash.final(&digest);
    if (!std.mem.eql(u8, &digest, &identity.sha256)) return error.ChecksumMismatch;
}

fn publish(file: std.Io.File, identity: Identity, destination: []const u8) !void {
    try verify(file, identity, header_size);
    const output = try io.cwd().createFile(io.io, destination, .{});
    errdefer {
        const previous = io.getIo().swapCancelProtection(.blocked);
        defer _ = io.getIo().swapCancelProtection(previous);
        io.deleteFile(destination) catch {};
    }
    defer output.close(io.io);
    var buffer: [65536]u8 = undefined;
    var offset: u64 = 0;
    while (offset < identity.size) {
        const length = try file.readPositionalAll(io.io, buffer[0..@intCast(@min(buffer.len, identity.size - offset))], header_size + offset);
        if (length == 0) return error.IncompleteDownload;
        try output.writePositionalAll(io.io, buffer[0..length], offset);
        offset += length;
    }
}

const Entry = struct { directory: std.Io.Dir, file: std.Io.File, key: []const u8 };

fn prepare(allocator: std.mem.Allocator, url: []const u8, identity: Identity, cache_root: []const u8) !Entry {
    _ = try io.cwd().createDirPathStatus(io.io, cache_root, if (builtin.os.tag == .windows) .default_dir else .fromMode(0o700));
    const root_stat = try io.cwd().statFile(io.io, cache_root, .{ .follow_symlinks = false });
    if (root_stat.kind != .directory or (builtin.os.tag != .windows and root_stat.permissions.toMode() & 0o777 != 0o700)) return error.UnsafePartialArchive;
    var directory = try io.cwd().openDir(io.io, cache_root, .{ .iterate = true, .follow_symlinks = false });
    errdefer directory.close(io.io);
    const key = try std.fmt.allocPrint(allocator, "{d}-{s}.partial", .{ identity.size, cacheKey(url, identity) });
    errdefer allocator.free(key);
    const file = admit(directory, key, identity) catch |err| return if (err == error.WouldBlock) error.PartialArchiveBusy else err;
    return .{ .directory = directory, .file = file, .key = key };
}

fn freshDownload(allocator: std.mem.Allocator, url: []const u8, destination: []const u8, identity: Identity, options: Options) !void {
    // A cache is optional. Use the same bounded receiver and verification in
    // an exclusively owned staging directory, without retaining it on failure.
    const directory = try io.createPrivateDirectory(allocator, std.fs.path.dirname(destination) orelse ".", "archive-download");
    defer allocator.free(directory);
    defer {
        const previous = io.getIo().swapCancelProtection(.blocked);
        defer _ = io.getIo().swapCancelProtection(previous);
        io.deleteTree(directory) catch {};
    }
    const path = try std.fs.path.join(allocator, &.{ directory, "partial" });
    defer allocator.free(path);
    const file = try io.cwd().createFile(io.io, path, .{ .read = true, .exclusive = true, .permissions = if (builtin.os.tag == .windows) .default_file else .fromMode(0o600) });
    defer file.close(io.io);
    try file.writePositionalAll(io.io, &identityHeader(identity), 0);
    try receive(allocator, url, file, identity, options);
    try publish(file, identity, destination);
}

fn receive(allocator: std.mem.Allocator, url: []const u8, file: std.Io.File, identity: Identity, options: Options) !void {
    var budget: io.HttpGetRetryBudget = .{ .max_retries = options.max_attempts - 1, .initial_delay_ms = options.retry_delay_ms };
    while (true) {
        attempt(allocator, url, file, identity, &budget) catch |err| {
            if (try budget.body(err)) continue;
            return err;
        };
        break;
    }
}

fn run(allocator: std.mem.Allocator, url: []const u8, destination: []const u8, identity: Identity, cache_root: []const u8, options: Options) !void {
    const entry = prepare(allocator, url, identity, cache_root) catch |err| switch (err) {
        error.PartialArchiveCacheFull, error.AccessDenied, error.ReadOnlyFileSystem, error.NoSpaceLeft, error.DiskQuota => return freshDownload(allocator, url, destination, identity, options),
        else => return err,
    };
    const directory = entry.directory;
    defer directory.close(io.io);
    const key = entry.key;
    defer allocator.free(key);
    const file = entry.file;
    defer file.close(io.io);
    try receive(allocator, url, file, identity, options);
    publish(file, identity, destination) catch |err| {
        if (err == error.ChecksumMismatch) {
            const previous = io.getIo().swapCancelProtection(.blocked);
            defer _ = io.getIo().swapCancelProtection(previous);
            directory.deleteFile(io.io, key) catch {};
        }
        return err;
    };
    try directory.deleteFile(io.io, key);
}

test "native archive resume: validators reject changed and incomplete ranges" {
    try std.testing.expect(strongEtag("\"immutable\""));
    try std.testing.expect(!strongEtag("W/\"weak\""));
    try std.testing.expect(!strongEtag("\"injected\r\nheader\""));
    try std.testing.expect(validRange("bytes 5-9/10", 5, 10));
    try std.testing.expect(!validRange("bytes 4-9/10", 5, 10));
    try std.testing.expect(!validRange("bytes 5-8/10", 5, 10));
    try std.testing.expect(!validRange("bytes 5-9/11", 5, 10));
    try std.testing.expect(!validRange("bytes */10", 5, 10));
}

const ResumePeer = struct {
    server: std.Io.net.Server,
    responses: []const []const u8,
    requests: [4][4096]u8 = undefined,
    lengths: [4]usize = @splat(0),
    first_sent: std.Io.Event = .unset,
    release_first: ?*std.Io.Event = null,

    fn serve(self: *@This()) !void {
        for (self.responses, 0..) |response, index| {
            const connection = try self.server.accept(std.testing.io);
            defer connection.close(std.testing.io);
            var head: [4096]u8 = undefined;
            var reader = connection.reader(std.testing.io, &head);
            while (true) {
                const line = try reader.interface.takeDelimiterInclusive('\n');
                if (self.lengths[index] + line.len > self.requests[index].len) return error.RequestTooLarge;
                @memcpy(self.requests[index][self.lengths[index]..][0..line.len], line);
                self.lengths[index] += line.len;
                if (std.mem.eql(u8, line, "\r\n")) break;
            }
            var bytes: [1024]u8 = undefined;
            var writer = connection.writer(std.testing.io, &bytes);
            try writer.interface.writeAll(response);
            try writer.interface.flush();
            if (index == 0) {
                self.first_sent.set(std.testing.io);
                if (self.release_first) |event| try event.wait(std.testing.io);
            }
        }
    }

    fn request(self: *const @This(), index: usize) []const u8 {
        return self.requests[index][0..self.lengths[index]];
    }
};

const truncated = "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nETag: \"fixture-v1\"\r\nConnection: close\r\n\r\nabc";
const remainder = "HTTP/1.1 206 Partial Content\r\nContent-Length: 7\r\nContent-Range: bytes 3-9/10\r\nETag: \"fixture-v1\"\r\nConnection: close\r\n\r\ndefghij";
const complete = "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nETag: \"fixture-v2\"\r\nConnection: close\r\n\r\nabcdefghij";

fn exercise(first: []const u8, second: []const u8, expected: ?anyerror, range_requested: bool, stall: bool) !void {
    const allocator = std.testing.allocator;
    const address = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
    var release: std.Io.Event = .unset;
    defer release.set(std.testing.io);
    var fixture: ResumePeer = .{ .server = try address.listen(std.testing.io, .{ .reuse_address = true }), .responses = &.{ first, second }, .release_first = if (stall) &release else null };
    defer fixture.server.deinit(std.testing.io);
    var serving = try std.testing.io.concurrent(ResumePeer.serve, .{&fixture});
    defer serving.cancel(std.testing.io) catch {};
    const url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/archive", .{fixture.server.socket.address.getPort()});
    defer allocator.free(url);
    const parent = try io.uniqueTempPath(allocator, "native-resume");
    defer allocator.free(parent);
    const cache = try io.createPrivateDirectory(allocator, parent, "partial");
    defer allocator.free(cache);
    defer io.deleteTree(parent) catch {};
    const output = try std.fs.path.join(allocator, &.{ parent, "archive" });
    defer allocator.free(output);
    var identity: Identity = .{ .sha256 = undefined, .size = 10 };
    std.crypto.hash.sha2.Sha256.hash("abcdefghij", &identity.sha256, .{});
    if (download(allocator, url, output, identity, cache, .{ .max_attempts = 1, .timeout_ms = if (stall) 100 else 5000 })) |_| {
        return error.TruncatedArchiveAccepted;
    } else |err| {
        if (stall) try std.testing.expectEqual(error.Timeout, err) else try std.testing.expect(err != error.Timeout);
    }
    try std.testing.expectError(error.FileNotFound, io.accessAbsolute(output, .{}));
    const partial = try std.fmt.allocPrint(allocator, "{s}/{d}-{s}.partial", .{ cache, identity.size, cacheKey(url, identity) });
    defer allocator.free(partial);
    try std.testing.expectEqual(@as(u64, header_size + 3), (try io.cwd().statFile(io.io, partial, .{})).size);
    release.set(std.testing.io);
    if (expected) |err| {
        try std.testing.expectError(err, download(allocator, url, output, identity, cache, .{ .max_attempts = 1, .timeout_ms = 5000 }));
    } else {
        try download(allocator, url, output, identity, cache, .{ .max_attempts = 1, .timeout_ms = 5000 });
    }
    try serving.await(std.testing.io);
    try std.testing.expectEqual(range_requested, std.ascii.findIgnoreCase(fixture.request(1), "Range: bytes=3-\r\n") != null);
    try std.testing.expectEqual(range_requested, std.ascii.findIgnoreCase(fixture.request(1), "If-Range: \"fixture-v1\"\r\n") != null);
    if (expected != null) {
        try std.testing.expectError(error.FileNotFound, io.accessAbsolute(output, .{}));
    } else {
        const bytes = try io.readFileAlloc(allocator, output, 100);
        defer allocator.free(bytes);
        try std.testing.expectEqualStrings("abcdefghij", bytes);
        try std.testing.expectError(error.FileNotFound, io.accessAbsolute(partial, .{}));
    }
    if (expected) |err| if (err == error.ChecksumMismatch) try std.testing.expectError(error.FileNotFound, io.accessAbsolute(partial, .{}));
}

test "native archive resume: a failed invocation retains bytes for the next verified install" {
    try exercise(truncated, remainder, null, true, false);
}

test "native archive resume: an unchanged deadline cancels and retains only quarantined bytes" {
    try exercise(truncated, remainder, null, true, true);
}

test "native archive resume: a server ignoring Range starts a fresh complete body" {
    try exercise(truncated, complete, null, true, false);
}

test "native archive resume: changed validators cannot append" {
    try exercise(truncated, "HTTP/1.1 206 Partial Content\r\nContent-Length: 7\r\nContent-Range: bytes 3-9/10\r\nETag: \"fixture-v2\"\r\nConnection: close\r\n\r\ndefghij", error.InvalidArchiveRange, true, false);
}

test "native archive resume: wrong ranges cannot append" {
    try exercise(truncated, "HTTP/1.1 206 Partial Content\r\nContent-Length: 7\r\nContent-Range: bytes 2-8/10\r\nETag: \"fixture-v1\"\r\nConnection: close\r\n\r\ndefghij", error.InvalidArchiveRange, true, false);
}

test "native archive resume: corrupt completed bytes never become an output archive" {
    try exercise(truncated, "HTTP/1.1 206 Partial Content\r\nContent-Length: 7\r\nContent-Range: bytes 3-9/10\r\nETag: \"fixture-v1\"\r\nConnection: close\r\n\r\ndefghiX", error.ChecksumMismatch, true, false);
}

test "native archive resume: unsatisfied ranges fail closed" {
    try exercise(truncated, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nContent-Range: bytes */10\r\nConnection: close\r\n\r\n", error.InvalidArchiveRange, true, false);
}

test "native archive resume: weak validators require a new complete body" {
    try exercise("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nETag: W/\"fixture-v1\"\r\nConnection: close\r\n\r\nabc", complete, null, false, false);
}

test "native archive resume: concurrent readers cannot mutate an active partial" {
    const allocator = std.testing.allocator;
    const address = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
    var release: std.Io.Event = .unset;
    defer release.set(std.testing.io);
    var peer: ResumePeer = .{ .server = try address.listen(std.testing.io, .{ .reuse_address = true }), .responses = &.{ truncated, remainder }, .release_first = &release };
    defer peer.server.deinit(std.testing.io);
    var serving = try std.testing.io.concurrent(ResumePeer.serve, .{&peer});
    defer serving.cancel(std.testing.io) catch {};
    const parent = try io.uniqueTempPath(allocator, "native-resume-concurrent");
    defer allocator.free(parent);
    defer io.deleteTree(parent) catch {};
    const cache = try io.createPrivateDirectory(allocator, parent, "partial");
    defer allocator.free(cache);
    const first_output = try std.fs.path.join(allocator, &.{ parent, "first" });
    defer allocator.free(first_output);
    const second_output = try std.fs.path.join(allocator, &.{ parent, "second" });
    defer allocator.free(second_output);
    const url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/archive", .{peer.server.socket.address.getPort()});
    defer allocator.free(url);
    var identity: Identity = .{ .sha256 = undefined, .size = 10 };
    std.crypto.hash.sha2.Sha256.hash("abcdefghij", &identity.sha256, .{});
    var first = try std.testing.io.concurrent(download, .{ allocator, url, first_output, identity, cache, Options{ .timeout_ms = 5000, .retry_delay_ms = 0 } });
    defer first.cancel(std.testing.io) catch {};
    try peer.first_sent.wait(std.testing.io);
    try std.testing.expectError(error.PartialArchiveBusy, download(allocator, url, second_output, identity, cache, .{ .timeout_ms = 5000 }));
    try std.testing.expectError(error.FileNotFound, io.accessAbsolute(second_output, .{}));
    release.set(std.testing.io);
    try first.await(std.testing.io);
    try serving.await(std.testing.io);
    const bytes = try io.readFileAlloc(allocator, first_output, 100);
    defer allocator.free(bytes);
    try std.testing.expectEqualStrings("abcdefghij", bytes);
    try std.testing.expect(std.ascii.findIgnoreCase(peer.request(1), "Range: bytes=3-\r\n") != null);
}

test "native archive resume: admission reserves active archive sizes without allocating their bodies" {
    const allocator = std.testing.allocator;
    const parent = try io.uniqueTempPath(allocator, "native-resume-quota");
    defer allocator.free(parent);
    const root = try io.createPrivateDirectory(allocator, parent, "partial");
    defer allocator.free(root);
    defer io.deleteTree(parent) catch {};
    var directory = try io.cwd().openDir(io.io, root, .{ .iterate = true });
    defer directory.close(io.io);
    const identity: Identity = .{ .sha256 = @splat(1), .size = 2 * 1024 * 1024 * 1024 };
    var files: [4]std.Io.File = undefined;
    var count: usize = 0;
    defer for (files[0..count]) |file| file.close(io.io);
    for (&files, 0..) |*file, index| {
        var name: [40]u8 = undefined;
        file.* = try admit(directory, try std.fmt.bufPrint(&name, "{d}-{d}.partial", .{ identity.size, index }), identity);
        count += 1;
        try std.testing.expectEqual(@as(u64, header_size), (try file.stat(io.io)).size);
    }
    try std.testing.expectError(error.PartialArchiveCacheFull, admit(directory, "extra.partial", .{ .sha256 = @splat(2), .size = 1 }));
}

test "native archive resume: cleanup reclaims expired idle entries and leaves active ones alone" {
    const allocator = std.testing.allocator;
    const parent = try io.uniqueTempPath(allocator, "native-resume-expiry");
    defer allocator.free(parent);
    const root = try io.createPrivateDirectory(allocator, parent, "partial");
    defer allocator.free(root);
    defer io.deleteTree(parent) catch {};
    var directory = try io.cwd().openDir(io.io, root, .{ .iterate = true });
    defer directory.close(io.io);
    const identity: Identity = .{ .sha256 = @splat(3), .size = 10 };
    const active = try admit(directory, "10-active.partial", identity);
    defer active.close(io.io);
    try active.setTimestamps(io.io, .{ .modify_timestamp = .{ .new = .zero } });
    const idle = try admit(directory, "10-idle.partial", identity);
    try idle.setTimestamps(io.io, .{ .modify_timestamp = .{ .new = .zero } });
    idle.close(io.io);
    const fresh = try admit(directory, "10-fresh.partial", identity);
    defer fresh.close(io.io);
    try std.testing.expectError(error.FileNotFound, directory.statFile(io.io, "10-idle.partial", .{}));
    try std.testing.expectEqual(@as(u64, header_size), (try directory.statFile(io.io, "10-active.partial", .{})).size);
}

fn fullCacheExercise(response: []const u8, expected: ?anyerror, stall: bool) !void {
    const allocator = std.testing.allocator;
    const address = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
    var release: std.Io.Event = .unset;
    defer release.set(std.testing.io);
    var peer: ResumePeer = .{ .server = try address.listen(std.testing.io, .{ .reuse_address = true }), .responses = &.{response}, .release_first = if (stall) &release else null };
    defer peer.server.deinit(std.testing.io);
    var serving = try std.testing.io.concurrent(ResumePeer.serve, .{&peer});
    defer serving.cancel(std.testing.io) catch {};
    const parent = try io.uniqueTempPath(allocator, "native-resume-full-cache");
    defer allocator.free(parent);
    defer io.deleteTree(parent) catch {};
    const root = try io.createPrivateDirectory(allocator, parent, "partial");
    defer allocator.free(root);
    var directory = try io.cwd().openDir(io.io, root, .{ .iterate = true });
    defer directory.close(io.io);
    const reserved: Identity = .{ .sha256 = @splat(1), .size = max_archive_size };
    const left = try admit(directory, "4294967296-left.partial", reserved);
    defer left.close(io.io);
    const right = try admit(directory, "4294967296-right.partial", reserved);
    defer right.close(io.io);
    const output = try std.fs.path.join(allocator, &.{ parent, "archive" });
    defer allocator.free(output);
    const url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/archive", .{peer.server.socket.address.getPort()});
    defer allocator.free(url);
    var identity: Identity = .{ .sha256 = undefined, .size = 10 };
    std.crypto.hash.sha2.Sha256.hash("abcdefghij", &identity.sha256, .{});
    const options: Options = .{ .max_attempts = 1, .timeout_ms = if (stall) 100 else 5000 };
    if (expected) |err| {
        try std.testing.expectError(err, download(allocator, url, output, identity, root, options));
        try std.testing.expectError(error.FileNotFound, io.accessAbsolute(output, .{}));
    } else {
        try download(allocator, url, output, identity, root, options);
        const bytes = try io.readFileAlloc(allocator, output, 100);
        defer allocator.free(bytes);
        try std.testing.expectEqualStrings("abcdefghij", bytes);
    }
    release.set(std.testing.io);
    try serving.await(std.testing.io);
    try std.testing.expect(std.ascii.findIgnoreCase(peer.request(0), "Range:") == null);
    try std.testing.expectEqual(@as(u64, header_size), (try left.stat(io.io)).size);
    try std.testing.expectEqual(@as(u64, header_size), (try right.stat(io.io)).size);
    var parent_directory = try io.cwd().openDir(io.io, parent, .{ .iterate = true });
    defer parent_directory.close(io.io);
    var children = parent_directory.iterate();
    while (try children.next(io.io)) |child| {
        try std.testing.expect(std.mem.eql(u8, child.name, std.fs.path.basename(root)) or (expected == null and std.mem.eql(u8, child.name, "archive")));
    }
}

test "native archive resume: cache capacity keeps fresh downloads verified" {
    try fullCacheExercise(complete, null, false);
}

test "native archive resume: a fresh transfer still rejects corrupt bytes without cache capacity" {
    try fullCacheExercise("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabcdefghiX", error.ChecksumMismatch, false);
}

test "native archive resume: cache refusal cannot reset the owned transfer deadline" {
    try fullCacheExercise(truncated, error.Timeout, true);
}

test "native archive resume: fresh transfers reject excess chunked bytes before waiting for EOF" {
    try fullCacheExercise("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nb\r\nabcdefghijX\r\n", error.InvalidArchiveLength, true);
}
