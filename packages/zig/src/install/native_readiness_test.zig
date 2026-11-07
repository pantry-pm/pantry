//! Public Installer.install readiness over an actual HTTP archive. The archive
//! is an interface fixture, not a released SDK or executable qualification.
const std = @import("std");
const io_helper = @import("../io_helper.zig");
const installer_mod = @import("installer.zig");
const native_deps = @import("native_deps.zig");
const PackageCache = @import("../cache.zig").PackageCache;

const archive = @embedFile("fixtures/execute-only-package.tar.gz");

const HeldArchive = struct {
    server: std.Io.net.Server,
    first_started: std.atomic.Value(bool) = .init(false),
    second_started: std.atomic.Value(bool) = .init(false),
    requests: std.atomic.Value(usize) = .init(0),

    fn serve(self: *HeldArchive) !void {
        const connection = try self.server.accept(std.testing.io);
        defer connection.close(std.testing.io);
        var head: [8192]u8 = undefined;
        var reader = connection.reader(std.testing.io, &head);
        const request = try reader.interface.takeDelimiterInclusive('\n');
        if (!std.mem.startsWith(u8, request, "GET /archive ")) return error.UnexpectedRequest;
        while (true) {
            if (std.mem.eql(u8, try reader.interface.takeDelimiterInclusive('\n'), "\r\n")) break;
        }
        _ = self.requests.fetchAdd(1, .monotonic);
        self.first_started.store(true, .release);
        while (!self.second_started.load(.acquire)) try std.testing.io.sleep(.{ .nanoseconds = std.time.ns_per_ms }, .awake);
        // Stall the real body after both callers have entered. This is fixture
        // release, not the success criterion: assertions observe completed
        // prefixes returned by the public interface, never elapsed duration.
        try std.testing.io.sleep(.{ .nanoseconds = std.time.ns_per_s }, .awake);
        var output: [1024]u8 = undefined;
        var writer = connection.writer(std.testing.io, &output);
        try writer.interface.print("HTTP/1.1 200 OK\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{archive.len});
        try writer.interface.writeAll(archive);
        try writer.interface.flush();
    }
};

const Lookup = struct {
    // Installed once before metadata workers start and immutable until their
    // joins/plan lifetime end. This adapter owns no installer behavior.
    var url: []const u8 = "";
    var digest: [32]u8 = undefined;

    fn resolve(allocator: std.mem.Allocator, _: []const u8, _: []const u8) !native_deps.Artifact {
        const version = try allocator.dupe(u8, "1.0.0");
        errdefer allocator.free(version);
        return .{ .version = version, .tarball_url = try allocator.dupe(u8, url), .sha256 = digest };
    }
};

const Caller = struct {
    installer: *installer_mod.Installer,
    plan: *const native_deps.Plan,
    project: []const u8,
    name: []const u8,
    started: ?*std.atomic.Value(bool) = null,
    result: ?installer_mod.InstallResult = null,
    failure: ?anyerror = null,
    ready_on_return: bool = false,

    fn run(self: *Caller) void {
        if (self.started) |flag| flag.store(true, .release);
        self.result = self.installer.install(.{ .name = self.name, .version = "1.0.0", .source = .pantry }, .{ .project_root = self.project, .native_plan = self.plan, .quiet = true }) catch |err| {
            self.failure = err;
            return;
        };
        const path = self.result.?.install_path;
        self.ready_on_return = path.len != 0 and blk: {
            const data_path = std.fmt.allocPrint(std.testing.allocator, "{s}/share/data", .{path}) catch break :blk false;
            defer std.testing.allocator.free(data_path);
            const data = io_helper.readFileAlloc(std.testing.allocator, data_path, 1024) catch break :blk false;
            defer std.testing.allocator.free(data);
            break :blk std.mem.eql(u8, data, "ordinary-data\n");
        };
    }

    fn deinit(self: *Caller) void {
        if (self.result) |*result| result.deinit(std.testing.allocator);
    }
};

fn waitStarted(flag: *std.atomic.Value(bool)) !void {
    while (!flag.load(.acquire)) try io_helper.getIo().sleep(.{ .nanoseconds = std.time.ns_per_ms }, .awake);
}

test "native readiness: concurrent public installs return completed prefixes instead of in-progress cached success" {
    const allocator = std.testing.allocator;
    defer installer_mod.shutdownAnalytics();
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const length = try temporary.dir.realPathFile(io_helper.io, ".", &buffer);
    const project = buffer[0..length];
    const name = try std.fmt.allocPrint(allocator, "readiness-{s}.pantry-fixture.test", .{std.fs.path.basename(project)});
    defer allocator.free(name);
    const address = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
    var fixture: HeldArchive = .{ .server = try address.listen(std.testing.io, .{ .reuse_address = true }) };
    var serving = try std.testing.io.concurrent(HeldArchive.serve, .{&fixture});
    defer {
        fixture.second_started.store(true, .release);
        serving.cancel(std.testing.io) catch {};
        fixture.server.deinit(std.testing.io);
    }
    const url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/archive", .{fixture.server.socket.address.getPort()});
    defer allocator.free(url);
    Lookup.url = url;
    defer Lookup.url = "";
    std.crypto.hash.sha2.Sha256.hash(archive, &Lookup.digest, .{});
    var plan = native_deps.Plan.init(allocator);
    defer plan.deinit();
    try plan.add(name, "1.0.0");
    try plan.resolveArtifactsUsing(.{}, Lookup.resolve);
    var package_cache = try PackageCache.init(allocator);
    defer package_cache.deinit();
    var installer = try installer_mod.Installer.init(allocator, &package_cache);
    defer installer.deinit();
    var first: Caller = .{ .installer = &installer, .plan = &plan, .project = project, .name = name };
    defer first.deinit();
    var second: Caller = .{ .installer = &installer, .plan = &plan, .project = project, .name = name, .started = &fixture.second_started };
    defer second.deinit();
    var first_thread: ?std.Thread = try std.Thread.spawn(.{}, Caller.run, .{&first});
    var second_thread: ?std.Thread = null;
    defer {
        fixture.second_started.store(true, .release);
        if (first_thread) |thread| thread.join();
        if (second_thread) |thread| thread.join();
    }
    try io_helper.runWithTimeout(waitStarted, .{&fixture.first_started}, 5000);
    second_thread = try std.Thread.spawn(.{}, Caller.run, .{&second});
    first_thread.?.join();
    first_thread = null;
    second_thread.?.join();
    second_thread = null;
    try serving.await(std.testing.io);
    if (first.failure) |err| return err;
    if (second.failure) |err| return err;
    const expected = try std.fmt.allocPrint(allocator, "{s}/pantry/{s}/v1.0.0", .{ project, name });
    defer allocator.free(expected);
    try std.testing.expect(first.ready_on_return);
    try std.testing.expect(second.ready_on_return);
    try std.testing.expectEqualStrings(expected, first.result.?.install_path);
    try std.testing.expectEqualStrings(expected, second.result.?.install_path);
    try std.testing.expectEqual(@as(usize, 1), fixture.requests.load(.monotonic));
}

test "native readiness: public pipeline results own native and GitHub installed versions" {
    const pipeline = @import("pipeline.zig");
    const allocator = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const length = try temporary.dir.realPathFile(io_helper.io, ".", &buffer);
    const root = buffer[0..length];
    const native_name = try std.fmt.allocPrint(allocator, "pipeline-{s}.pantry-fixture.test", .{std.fs.path.basename(root)});
    defer allocator.free(native_name);
    const native_share = try std.fmt.allocPrint(allocator, "pantry/{s}/v1.0.0/share", .{native_name});
    defer allocator.free(native_share);
    try temporary.dir.createDirPath(io_helper.io, native_share);
    const native_file = try std.fmt.allocPrint(allocator, "{s}/data", .{native_share});
    defer allocator.free(native_file);
    try temporary.dir.writeFile(io_helper.io, .{ .sub_path = native_file, .data = "native cached payload\n" });
    try temporary.dir.createDirPath(io_helper.io, "pantry/github-cache-fixture/share");
    try temporary.dir.writeFile(io_helper.io, .{ .sub_path = "pantry/github-cache-fixture/share/data", .data = "GitHub cached payload\n" });

    // A completed public session plan owns the metadata adapter's version.
    // Payloads are actual project cache fixtures; no clone, registry or SDK
    // execution is claimed by this allocator/result ownership regression.
    const Metadata = struct {
        fn version(alloc: std.mem.Allocator, _: []const u8, _: []const u8) ![]const u8 {
            return alloc.dupe(u8, "1.0.0");
        }
    };
    var session = native_deps.Session.init(allocator, null, false, false);
    defer session.deinit();
    session.plan = native_deps.Plan.init(allocator);
    try session.plan.?.add(native_name, "1.0.0");
    try session.plan.?.resolveUsing(session.policy(), Metadata.version);
    var package_cache = try PackageCache.init(allocator);
    defer package_cache.deinit();
    var installer = try installer_mod.Installer.init(allocator, &package_cache);
    defer installer.deinit();
    installer.native_session = &session;
    installer.native_policy = session.policy();
    var result = try pipeline.run(allocator, &installer, &.{
        .{ .name = native_name, .version = "1.0.0", .source = .pantry },
        .{ .name = "github-cache-fixture", .version = "fixture-tag", .source = .github, .github_owner = "fixture-owner", .github_repo = "fixture-repository" },
    }, root, false);
    defer result.deinit(allocator);
    try std.testing.expectEqual(@as(usize, 0), result.failed_count);
    try std.testing.expectEqual(@as(usize, 0), result.installed_count);
    try std.testing.expectEqual(@as(usize, 2), result.cached_count);
    try std.testing.expectEqual(@as(usize, 2), result.results.len);
    for (result.results) |entry| {
        try std.testing.expect(entry.success and entry.from_cache);
        if (std.mem.eql(u8, entry.name, native_name)) {
            try std.testing.expect(entry.source.? == .pantry);
            try std.testing.expectEqualStrings("1.0.0", entry.version);
        } else {
            try std.testing.expectEqualStrings("github-cache-fixture", entry.name);
            try std.testing.expect(entry.source.? == .github);
            try std.testing.expectEqualStrings("fixture-tag", entry.version);
        }
    }
    const native_path = try std.fs.path.join(allocator, &.{ root, native_file });
    defer allocator.free(native_path);
    const native_data = try io_helper.readFileAlloc(allocator, native_path, 1024);
    defer allocator.free(native_data);
    try std.testing.expectEqualStrings("native cached payload\n", native_data);
    const github_path = try std.fs.path.join(allocator, &.{ root, "pantry/github-cache-fixture/share/data" });
    defer allocator.free(github_path);
    const github_data = try io_helper.readFileAlloc(allocator, github_path, 1024);
    defer allocator.free(github_data);
    try std.testing.expectEqualStrings("GitHub cached payload\n", github_data);
}
