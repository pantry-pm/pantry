const std = @import("std");
const builtin = @import("builtin");
const io_helper = @import("io_helper.zig");
const registry = @import("cli/commands/registry.zig");

fn write(path: []const u8, content: []const u8) !void {
    const file = try io_helper.createFile(path, .{ .truncate = true });
    defer io_helper.closeFile(file);
    try io_helper.writeAllToFile(file, content);
}

test "publish archive: explicit source entries retain file and directory links" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const root = try io_helper.uniqueTempPath(allocator, "pantry-publish-links");
    defer io_helper.deleteTree(root) catch {};
    const source = try std.fs.path.join(allocator, &.{ root, "source" });
    const assets = try std.fs.path.join(allocator, &.{ source, "assets" });
    try io_helper.makePath(assets);
    const manifest =
        \\{"name":"archive-fixture","version":"1.0.0","files":["source"],"bin":{"fixture":"source/README.link"}}
    ;
    try write(try std.fs.path.join(allocator, &.{ root, "package.json" }), manifest);
    try write(try std.fs.path.join(allocator, &.{ source, "README.txt" }), "reviewed source");
    try write(try std.fs.path.join(allocator, &.{ assets, "mark.txt" }), "reviewed asset");
    try io_helper.symLink("README.txt", try std.fs.path.join(allocator, &.{ source, "README.link" }));
    try io_helper.symLink("assets", try std.fs.path.join(allocator, &.{ source, "assets-link" }));

    const archive = try registry.createTarball(allocator, root, std.fs.path.basename(root), "1.0.0", manifest);
    defer io_helper.deleteFile(archive) catch {};
    const unpacked = try std.fs.path.join(allocator, &.{ root, "unpacked" });
    try io_helper.makePath(unpacked);
    const result = try io_helper.childRun(allocator, &.{ "tar", "-xzf", archive, "-C", unpacked });
    try std.testing.expect(result.term == .exited and result.term.exited == 0);
    const extracted = try std.fs.path.join(allocator, &.{ unpacked, "package", "source" });
    try std.testing.expectEqualStrings("README.txt", try io_helper.readLinkAlloc(allocator, try std.fs.path.join(allocator, &.{ extracted, "README.link" })));
    try std.testing.expectEqualStrings("assets", try io_helper.readLinkAlloc(allocator, try std.fs.path.join(allocator, &.{ extracted, "assets-link" })));
    try std.testing.expectEqualStrings("reviewed source", try io_helper.readFileAlloc(allocator, try std.fs.path.join(allocator, &.{ extracted, "README.link" }), 1024));
    try std.testing.expectEqualStrings("reviewed asset", try io_helper.readFileAlloc(allocator, try std.fs.path.join(allocator, &.{ extracted, "assets-link", "mark.txt" }), 1024));
}

test "publish archive: a missing explicit source entry refuses an incomplete package" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const root = try io_helper.uniqueTempPath(allocator, "pantry-publish-missing");
    defer io_helper.deleteTree(root) catch {};
    try io_helper.makePath(root);
    const manifest =
        \\{"name":"archive-fixture","version":"1.0.0","files":["missing-source"]}
    ;
    try write(try std.fs.path.join(allocator, &.{ root, "package.json" }), manifest);
    const archive = try std.fmt.allocPrint(allocator, "{s}/{s}-1.0.0.tgz", .{ io_helper.getTempDir(), std.fs.path.basename(root) });
    defer io_helper.deleteFile(archive) catch {};
    try std.testing.expectError(error.TarballCreationFailed, registry.createTarball(allocator, root, std.fs.path.basename(root), "1.0.0", manifest));
}
