const std = @import("std");
const builtin = @import("builtin");
const io_helper = @import("io_helper.zig");
const registry = @import("cli/commands/registry.zig");
const publish_archive = @import("cli/commands/publish_archive.zig");

fn write(path: []const u8, content: []const u8) !void {
    const file = try io_helper.createFile(path, .{ .truncate = true });
    defer io_helper.closeFile(file);
    try io_helper.writeAllToFile(file, content);
}

test "publish archive: portable tar metadata handles text bins, links and long names without chmod" {
    if (!io_helper.File.Permissions.has_executable_bit) return error.SkipZigTest;
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    for ([_]bool{ false, true }) |object_bin| {
        const root = try io_helper.uniqueTempPath(allocator, "pantry-portable-archive");
        defer io_helper.deleteTree(root) catch {};
        const stage = try std.fs.path.join(allocator, &.{ root, "stage" });
        const package = try std.fs.path.join(allocator, &.{ stage, "package" });
        try io_helper.makePath(package);
        const cli = try std.fs.path.join(allocator, &.{ package, "cli" });
        const text = try std.fs.path.join(allocator, &.{ package, "index.txt" });
        const library = try std.fs.path.join(allocator, &.{ package, "library.js" });
        try write(cli, "#!/bin/sh\nprintf portable-bin-ok\n");
        try write(text, "declared text bin\n");
        try write(library, "export const value = 1;\n");
        for ([_][]const u8{ cli, text, library }) |path| {
            const file = try io_helper.openFileAbsolute(path, .{});
            defer file.close(io_helper.io);
            try file.setPermissions(io_helper.io, io_helper.File.Permissions.fromMode(if (std.mem.eql(u8, path, library)) 0o640 else 0o644));
        }
        try io_helper.symLink("cli", try std.fs.path.join(allocator, &.{ package, "cli-alias" }));
        const component = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const long_target = component ++ "/" ++ component ++ "/leaf.txt";
        try io_helper.makePath(try std.fs.path.join(allocator, &.{ package, component, component }));
        try write(try std.fs.path.join(allocator, &.{ package, long_target }), "long path payload");
        try io_helper.symLink(long_target, try std.fs.path.join(allocator, &.{ package, "long-link" }));
        const config = if (object_bin) "{\"bin\":{\"script\":\"cli-alias\",\"text\":\"index.txt\"}}" else "{\"bin\":\"cli-alias\"}";
        const archive = try std.fs.path.join(allocator, &.{ root, "portable.tgz" });
        try publish_archive.packPortable(allocator, stage, archive, config);
        try std.testing.expectEqual(@as(u32, 0o644), (try io_helper.statFile(cli)).mode & 0o777);
        try std.testing.expectEqual(@as(u32, 0o644), (try io_helper.statFile(text)).mode & 0o777);
        const unpacked = try std.fs.path.join(allocator, &.{ root, "unpacked" });
        try io_helper.makePath(unpacked);
        const result = try io_helper.childRun(allocator, &.{ "tar", "-xzf", archive, "-C", unpacked });
        try std.testing.expect(result.term == .exited and result.term.exited == 0);
        const published = try std.fs.path.join(allocator, &.{ unpacked, "package" });
        try std.testing.expectEqual(@as(u32, 0o755), (try io_helper.statFile(try std.fs.path.join(allocator, &.{ published, "cli" }))).mode & 0o777);
        try std.testing.expectEqual(@as(u32, if (object_bin) 0o755 else 0o644), (try io_helper.statFile(try std.fs.path.join(allocator, &.{ published, "index.txt" }))).mode & 0o777);
        try std.testing.expectEqual(@as(u32, 0o640), (try io_helper.statFile(try std.fs.path.join(allocator, &.{ published, "library.js" }))).mode & 0o777);
        try std.testing.expectEqualStrings("cli", try io_helper.readLinkAlloc(allocator, try std.fs.path.join(allocator, &.{ published, "cli-alias" })));
        try std.testing.expectEqualStrings(long_target, try io_helper.readLinkAlloc(allocator, try std.fs.path.join(allocator, &.{ published, "long-link" })));
        try std.testing.expectEqualStrings("long path payload", try io_helper.readFileAlloc(allocator, try std.fs.path.join(allocator, &.{ published, "long-link" }), 1024));
        const executed = try io_helper.childRun(allocator, &.{try std.fs.path.join(allocator, &.{ published, "cli-alias" })});
        try std.testing.expect(executed.term == .exited and executed.term.exited == 0);
        try std.testing.expectEqualStrings("portable-bin-ok", executed.stdout);
        const outside = try std.fs.path.join(allocator, &.{ root, "outside" });
        try write(outside, "outside owned stage");
        try io_helper.symLink(outside, try std.fs.path.join(allocator, &.{ package, "external-bin" }));
        try std.testing.expectError(error.InvalidBinTarget, publish_archive.packPortable(allocator, stage, archive, "{\"bin\":\"external-bin\"}"));
    }
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

test "publish archive: declared bins execute without changing source or library permissions" {
    if (!io_helper.File.Permissions.has_executable_bit) return error.SkipZigTest;
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    for ([_][]const u8{ "package.json", "pantry.json" }) |manifest_name| {
        for ([_]bool{ false, true }) |explicit_files| {
            for ([_]bool{ false, true }) |object_bin| {
                const root = try io_helper.uniqueTempPath(allocator, "pantry-publish-bin-mode");
                defer io_helper.deleteTree(root) catch {};
                try io_helper.makePath(try std.fs.path.join(allocator, &.{ root, "dist" }));
                try io_helper.makePath(try std.fs.path.join(allocator, &.{ root, "bin" }));
                const cli = try std.fs.path.join(allocator, &.{ root, "bin", "cli" });
                const library = try std.fs.path.join(allocator, &.{ root, "dist", "index.js" });
                try write(cli, "#!/bin/sh\nprintf 'published-bin-ok'\n");
                try write(library, "export const value = 1;\n");
                for ([_][]const u8{ cli, library }) |path| {
                    const file = try io_helper.openFileAbsolute(path, .{});
                    defer file.close(io_helper.io);
                    try file.setPermissions(io_helper.io, io_helper.File.Permissions.fromMode(0o644));
                }
                const manifest = try std.fmt.allocPrint(
                    allocator,
                    "{{\"name\":\"archive-bin-fixture\",\"version\":\"1.0.0\",{s}\"bin\":{s}}}",
                    .{ if (explicit_files) "\"files\":[\"dist\"]," else "", if (object_bin) "{\"fixture\":\"./bin/cli\"}" else "\"./bin/cli\"" },
                );
                try write(try std.fs.path.join(allocator, &.{ root, manifest_name }), manifest);
                const archive = try registry.createTarball(allocator, root, std.fs.path.basename(root), "1.0.0", manifest);
                defer io_helper.deleteFile(archive) catch {};
                const unpacked = try std.fs.path.join(allocator, &.{ root, "unpacked" });
                try io_helper.makePath(unpacked);
                const extract = try io_helper.childRun(allocator, &.{ "tar", "-xzf", archive, "-C", unpacked });
                try std.testing.expect(extract.term == .exited and extract.term.exited == 0);
                const published_cli = try std.fs.path.join(allocator, &.{ unpacked, "package", "bin", "cli" });
                const published_library = try std.fs.path.join(allocator, &.{ unpacked, "package", "dist", "index.js" });
                try std.testing.expectEqual(@as(u32, 0o755), (try io_helper.statFile(published_cli)).mode & 0o777);
                try std.testing.expectEqual(@as(u32, 0o644), (try io_helper.statFile(published_library)).mode & 0o777);
                try std.testing.expectEqual(@as(u32, 0o644), (try io_helper.statFile(cli)).mode & 0o777);
                const executed = try io_helper.childRun(allocator, &.{published_cli});
                try std.testing.expect(executed.term == .exited and executed.term.exited == 0);
                try std.testing.expectEqualStrings("published-bin-ok", executed.stdout);
            }
        }
    }
}

test "publish archive: every declared bin is included beyond sixteen commands" {
    if (!io_helper.File.Permissions.has_executable_bit) return error.SkipZigTest;
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const root = try io_helper.uniqueTempPath(allocator, "pantry-publish-many-bins");
    defer io_helper.deleteTree(root) catch {};
    try io_helper.makePath(try std.fs.path.join(allocator, &.{ root, "dist" }));
    try io_helper.makePath(try std.fs.path.join(allocator, &.{ root, "scripts" }));
    try write(try std.fs.path.join(allocator, &.{ root, "dist", "index.js" }), "export const value = 1;");
    var manifest: std.ArrayList(u8) = .empty;
    try manifest.appendSlice(allocator, "{\"name\":\"many-bins\",\"version\":\"1.0.0\",\"files\":[\"dist\"],\"bin\":{");
    for (0..20) |index| {
        if (index > 0) try manifest.append(allocator, ',');
        const entry = try std.fmt.allocPrint(allocator, "\"cli{d}\":\"./scripts/cli{d}\"", .{ index, index });
        try manifest.appendSlice(allocator, entry);
        const path = try std.fmt.allocPrint(allocator, "{s}/scripts/cli{d}", .{ root, index });
        try write(path, "#!/bin/sh\nexit 0\n");
    }
    try manifest.appendSlice(allocator, "}}");
    try write(try std.fs.path.join(allocator, &.{ root, "package.json" }), manifest.items);
    const archive = try registry.createTarball(allocator, root, std.fs.path.basename(root), "1.0.0", manifest.items);
    defer io_helper.deleteFile(archive) catch {};
    const unpacked = try std.fs.path.join(allocator, &.{ root, "unpacked" });
    try io_helper.makePath(unpacked);
    const extract = try io_helper.childRun(allocator, &.{ "tar", "-xzf", archive, "-C", unpacked });
    try std.testing.expect(extract.term == .exited and extract.term.exited == 0);
    for (0..20) |index| {
        const path = try std.fmt.allocPrint(allocator, "{s}/package/scripts/cli{d}", .{ unpacked, index });
        try std.testing.expectEqual(@as(u32, 0o755), (try io_helper.statFile(path)).mode & 0o777);
    }
}

test "publish archive: external bin links cannot alter files outside the stage" {
    if (!io_helper.File.Permissions.has_executable_bit) return error.SkipZigTest;
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    for ([_]bool{ false, true }) |explicit_files| {
        const root = try io_helper.uniqueTempPath(allocator, "pantry-publish-outside-bin");
        defer io_helper.deleteTree(root) catch {};
        const package = try std.fs.path.join(allocator, &.{ root, "pkg" });
        try io_helper.makePath(package);
        const outside = try std.fs.path.join(allocator, &.{ root, "outside" });
        try write(outside, "#!/bin/sh\nexit 0\n");
        const file = try io_helper.openFileAbsolute(outside, .{});
        defer file.close(io_helper.io);
        try file.setPermissions(io_helper.io, io_helper.File.Permissions.fromMode(0o644));
        try io_helper.symLink(outside, try std.fs.path.join(allocator, &.{ package, "link" }));
        const manifest = try std.fmt.allocPrint(
            allocator,
            "{{\"name\":\"outside-bin\",\"version\":\"1.0.0\",{s}\"bin\":\"link\"}}",
            .{if (explicit_files) "\"files\":[\"link\"]," else ""},
        );
        try write(try std.fs.path.join(allocator, &.{ package, "package.json" }), manifest);
        try std.testing.expectError(error.InvalidBinTarget, registry.createTarball(allocator, package, std.fs.path.basename(root), "1.0.0", manifest));
        try std.testing.expectEqual(@as(u32, 0o644), (try io_helper.statFile(outside)).mode & 0o777);
    }
}
