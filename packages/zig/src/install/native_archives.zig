//! Prepared archives belong to one completed native plan and one invocation.
//! They contain unverified bytes only. Installers still verify private copies
//! before materialization, and preserve dependency/finalizer ordering.
const std = @import("std");
const io_helper = @import("../io_helper.zig");
const downloader = @import("downloader.zig");
const native_deps = @import("native_deps.zig");

pub const Request = struct {
    name: []const u8,
    version: []const u8,
    artifact: ?native_deps.Artifact,
};

const Entry = struct {
    name: []const u8,
    version: []const u8,
    path: []const u8,
    url: ?[]const u8 = null,
    resolved: bool = false,
    sha256: ?[32]u8 = null,
    available: bool = false,
    failure: ?anyerror = null,
    capture: io_helper.TransientGetCapture = .{},
    mutex: io_helper.Mutex = .{},
};

pub const Prepared = struct {
    allocator: std.mem.Allocator,
    root: ?[]const u8,
    entries: []Entry,

    /// All request slices are borrowed only until this joined call returns.
    /// Failures remain attached to their entry until its ordered consumer runs.
    pub fn init(allocator: std.mem.Allocator, parent: []const u8, requests: []const Request) !Prepared {
        if (requests.len == 0) return .{ .allocator = allocator, .root = null, .entries = &.{} };
        const root = io_helper.createPrivateDirectory(allocator, parent, "native-archives") catch |err| {
            if (err == error.OutOfMemory or err == error.Canceled) return err;
            // Cancellation and allocation failures remain terminal. No request
            // has started. Decline this optional optimization when
            // its staging is unavailable; ordered installers retain ownership
            // of each package's staging error and mixed-provider reporting.
            return .{ .allocator = allocator, .root = null, .entries = &.{} };
        };
        errdefer {
            io_helper.deleteTree(root) catch {};
            allocator.free(root);
        }
        var entries: std.ArrayList(Entry) = .empty;
        errdefer {
            for (entries.items) |entry| freeEntry(allocator, entry);
            entries.deinit(allocator);
        }
        for (requests, 0..) |request, index| {
            if (request.artifact) |artifact| {
                if (!std.mem.eql(u8, request.version, artifact.version)) return error.NativeConstraintConflict;
            }
            const name = try allocator.dupe(u8, request.name);
            errdefer allocator.free(name);
            const version = try allocator.dupe(u8, request.version);
            errdefer allocator.free(version);
            const path = try std.fmt.allocPrint(allocator, "{s}/{d}.tar.gz", .{ root, index });
            errdefer allocator.free(path);
            const url = if (request.artifact) |artifact| if (artifact.tarball_url) |url| try allocator.dupe(u8, url) else null else null;
            errdefer if (url) |owned| allocator.free(owned);
            try entries.append(allocator, .{ .name = name, .version = version, .path = path, .url = url, .resolved = request.artifact != null, .sha256 = if (request.artifact) |artifact| artifact.sha256 else null });
        }
        var self: Prepared = .{ .allocator = allocator, .root = root, .entries = try entries.toOwnedSlice(allocator) };
        var next: std.atomic.Value(usize) = .init(0);
        const Worker = struct {
            prepared: *Prepared,
            next: *std.atomic.Value(usize),
            fn run(ctx: *@This()) void {
                while (true) {
                    const index = ctx.next.fetchAdd(1, .monotonic);
                    if (index >= ctx.prepared.entries.len) return;
                    const entry = &ctx.prepared.entries[index];
                    ctx.prepared.acquire(entry) catch |err| {
                        entry.failure = err;
                    };
                }
            }
        };
        var worker: Worker = .{ .prepared = &self, .next = &next };
        var threads: [7]?std.Thread = @splat(null);
        const count = @min(requests.len, 8);
        for (threads[0..count -| 1]) |*thread| thread.* = std.Thread.spawn(.{}, Worker.run, .{&worker}) catch null;
        Worker.run(&worker);
        for (threads) |thread| if (thread) |running| running.join();
        return self;
    }

    fn acquire(self: *Prepared, entry: *Entry) !void {
        if (!entry.resolved) {
            const found = try downloader.lookupS3RegistryWithCapture(self.allocator, entry.name, entry.version, &entry.capture) orelse
                try downloader.lookupPantryPublishedWithCapture(self.allocator, entry.name, entry.version, &entry.capture);
            if (found) |artifact| {
                defer self.allocator.free(artifact.version);
                if (!std.mem.eql(u8, entry.version, artifact.version)) {
                    self.allocator.free(artifact.tarball_url);
                    return error.NativeConstraintConflict;
                }
                entry.url = artifact.tarball_url;
                entry.sha256 = artifact.sha256;
            }
            entry.resolved = true;
        }
        const url = entry.url orelse return;
        try downloader.downloadFileWithCapture(self.allocator, url, entry.path, true, null, &entry.capture);
        entry.available = true;
    }

    pub fn deinit(self: *Prepared) void {
        // Callers have joined every installer descendant before releasing us.
        const root = self.root orelse return;
        io_helper.deleteTree(root) catch {};
        for (self.entries) |entry| freeEntry(self.allocator, entry);
        self.allocator.free(self.entries);
        self.allocator.free(root);
    }

    fn find(self: *Prepared, name: []const u8, version: []const u8) ?*Entry {
        for (self.entries) |*entry| {
            if (std.mem.eql(u8, entry.name, name) and std.mem.eql(u8, entry.version, version)) return entry;
        }
        return null;
    }

    /// Consult before an installer repeats metadata lookup. A failed prepare is
    /// reported once, on its own package; a real outer retry may fetch anew.
    pub fn artifactFor(self: *Prepared, name: []const u8, version: []const u8, capture: ?*io_helper.TransientGetCapture) !?native_deps.Artifact {
        const entry = self.find(name, version) orelse return null;
        entry.mutex.lock();
        defer entry.mutex.unlock();
        if (entry.failure) |failure| {
            entry.failure = null;
            if (capture) |target| target.* = entry.capture;
            return failure;
        }
        if (!entry.resolved) return null;
        return .{ .version = entry.version, .tarball_url = entry.url, .sha256 = entry.sha256 };
    }

    pub fn copyTo(self: *Prepared, name: []const u8, version: []const u8, destination: []const u8) !bool {
        const entry = self.find(name, version) orelse return false;
        entry.mutex.lock();
        defer entry.mutex.unlock();
        if (!entry.available) return false;
        try io_helper.copyFile(entry.path, destination);
        return true;
    }

    pub fn invalidate(self: *Prepared, name: []const u8, version: []const u8) void {
        const entry = self.find(name, version) orelse return;
        entry.mutex.lock();
        defer entry.mutex.unlock();
        // Retain the file until deinit, including on Windows. Existing copies
        // remain independently owned and verified by their own staging.
        entry.available = false;
    }
};

fn freeEntry(allocator: std.mem.Allocator, entry: Entry) void {
    allocator.free(entry.name);
    allocator.free(entry.version);
    allocator.free(entry.path);
    if (entry.url) |url| allocator.free(url);
}

const ConcurrentFixture = struct {
    server: std.Io.net.Server,
    response: []const u8,
    requests: std.atomic.Value(usize) = .init(0),

    fn serve(self: *ConcurrentFixture) !void {
        // Do not answer the first GET until both headers have arrived. This
        // witnesses overlapping acquisition rather than relying on elapsed time.
        const first = try self.server.accept(std.testing.io);
        defer first.close(std.testing.io);
        try self.readHead(first);
        const second = try self.server.accept(std.testing.io);
        defer second.close(std.testing.io);
        try self.readHead(second);
        try self.respond(first);
        try self.respond(second);
    }

    fn readHead(self: *ConcurrentFixture, stream: std.Io.net.Stream) !void {
        var buffer: [8192]u8 = undefined;
        var reader = stream.reader(std.testing.io, &buffer);
        while (true) {
            const line = try reader.interface.takeDelimiterInclusive('\n');
            if (std.mem.eql(u8, line, "\r\n")) break;
        }
        _ = self.requests.fetchAdd(1, .monotonic);
    }

    fn respond(self: *ConcurrentFixture, stream: std.Io.net.Stream) !void {
        var buffer: [1024]u8 = undefined;
        var writer = stream.writer(std.testing.io, &buffer);
        try writer.interface.writeAll(self.response);
        try writer.interface.flush();
    }
};

test "native archive preparation overlaps real GETs and retains independent staging copies" {
    const allocator = std.testing.allocator;
    const address = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
    var fixture: ConcurrentFixture = .{ .server = try address.listen(std.testing.io, .{ .reuse_address = true }), .response = "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\ncomplete" };
    defer fixture.server.deinit(std.testing.io);
    var serving = try std.testing.io.concurrent(ConcurrentFixture.serve, .{&fixture});
    defer serving.cancel(std.testing.io) catch {};
    const url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/archive", .{fixture.server.socket.address.getPort()});
    defer allocator.free(url);
    const parent = try io_helper.uniqueTempPath(allocator, "pantry-prepared-test");
    defer allocator.free(parent);
    defer io_helper.deleteTree(parent) catch {};
    var prepared = try Prepared.init(allocator, parent, &.{
        .{ .name = "first.example", .version = "1.0.0", .artifact = .{ .version = "1.0.0", .tarball_url = url } },
        .{ .name = "second.example", .version = "2.0.0", .artifact = .{ .version = "2.0.0", .tarball_url = url } },
    });
    var released = false;
    defer if (!released) prepared.deinit();
    try serving.await(std.testing.io);
    try std.testing.expectEqual(@as(usize, 2), fixture.requests.load(.monotonic));
    const artifact = (try prepared.artifactFor("first.example", "1.0.0", null)).?;
    try std.testing.expectEqualStrings(url, artifact.tarball_url.?);
    try std.testing.expect((try prepared.artifactFor("first.example", "2.0.0", null)) == null);
    const destination = try std.fs.path.join(allocator, &.{ parent, "copy.tar.gz" });
    defer allocator.free(destination);
    try std.testing.expect(try prepared.copyTo("first.example", "1.0.0", destination));
    prepared.invalidate("first.example", "1.0.0");
    try std.testing.expect(!try prepared.copyTo("first.example", "1.0.0", destination));
    const root = try allocator.dupe(u8, prepared.root.?);
    defer allocator.free(root);
    prepared.deinit();
    released = true;
    try std.testing.expectError(error.FileNotFound, io_helper.cwd().access(io_helper.io, root, .{}));
    const contents = try io_helper.readFileAlloc(allocator, destination, 1000);
    defer allocator.free(contents);
    try std.testing.expectEqualStrings("complete", contents);
}

test "native archive preparation delivers a typed failure only to its exact consumer" {
    const allocator = std.testing.allocator;
    const address = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
    var fixture: ConcurrentFixture = .{ .server = try address.listen(std.testing.io, .{ .reuse_address = true }), .response = "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 401\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" };
    defer fixture.server.deinit(std.testing.io);
    var serving = try std.testing.io.concurrent(ConcurrentFixture.serve, .{&fixture});
    defer serving.cancel(std.testing.io) catch {};
    const url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/archive", .{fixture.server.socket.address.getPort()});
    defer allocator.free(url);
    const parent = try io_helper.uniqueTempPath(allocator, "pantry-prepared-failure");
    defer allocator.free(parent);
    defer io_helper.deleteTree(parent) catch {};
    var prepared = try Prepared.init(allocator, parent, &.{
        .{ .name = "first.example", .version = "1.0.0", .artifact = .{ .version = "1.0.0", .tarball_url = url } },
        .{ .name = "second.example", .version = "1.0.0", .artifact = .{ .version = "1.0.0", .tarball_url = url } },
    });
    defer prepared.deinit();
    try serving.await(std.testing.io);
    try std.testing.expectEqual(@as(usize, 2), fixture.requests.load(.monotonic));
    var capture: io_helper.TransientGetCapture = .{};
    try std.testing.expect((try prepared.artifactFor("other.example", "1.0.0", &capture)) == null);
    try std.testing.expect(capture.record == null);
    try std.testing.expectError(error.RegistryUnavailable, prepared.artifactFor("first.example", "1.0.0", &capture));
    try std.testing.expectEqual(@as(u16, 503), capture.record.?.status);
    try std.testing.expectEqual(@as(u32, 401), capture.record.?.retry_after_seconds);
    capture = .{};
    try std.testing.expect((try prepared.artifactFor("first.example", "1.0.0", &capture)) != null);
    try std.testing.expect(capture.record == null);
    try std.testing.expectError(error.RegistryUnavailable, prepared.artifactFor("second.example", "1.0.0", &capture));
    const destination = try std.fs.path.join(allocator, &.{ parent, "absent" });
    defer allocator.free(destination);
    try std.testing.expect(!try prepared.copyTo("first.example", "1.0.0", destination));
    try std.testing.expectError(error.FileNotFound, io_helper.cwd().access(io_helper.io, destination, .{}));
}

test "empty native archive preparation needs no allocator or filesystem staging" {
    var prepared = try Prepared.init(std.testing.failing_allocator, "\x00", &.{});
    defer prepared.deinit();
    try std.testing.expect(prepared.root == null);
    try std.testing.expect((try prepared.artifactFor("none.example", "1.0.0", null)) == null);
    try std.testing.expect(!try prepared.copyTo("none.example", "1.0.0", "\x00"));
}

test "unavailable native preparation staging preserves ordered installer error ownership" {
    const allocator = std.testing.allocator;
    const parent = try io_helper.uniqueTempPath(allocator, "pantry-prepared-staging-error");
    defer allocator.free(parent);
    const file = try io_helper.cwd().createFile(io_helper.io, parent, .{});
    file.close(io_helper.io);
    defer io_helper.deleteFile(parent) catch {};
    const request: Request = .{ .name = "fixture.example", .version = "1.0.0", .artifact = .{ .version = "1.0.0", .tarball_url = "http://127.0.0.1:1/must-not-fetch" } };
    var prepared = try Prepared.init(allocator, parent, &.{request});
    defer prepared.deinit();
    try std.testing.expect(prepared.root == null);
    try std.testing.expect((try prepared.artifactFor(request.name, request.version, null)) == null);
    // Allocation failures are not converted into staging unavailability.
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const length = try temporary.dir.realPathFile(io_helper.io, ".", &buffer);
    try std.testing.expectError(error.OutOfMemory, Prepared.init(std.testing.failing_allocator, buffer[0..length], &.{request}));
}
