//! Native publication staging with the shared ignore policy.
const std = @import("std");
const io_helper = @import("../../io_helper.zig");
const publish_ignore = @import("publish_ignore.zig");

/// Copy selected publication entries without invoking an external copy tool.
/// Excluded directories are pruned and links are copied without traversal.
pub fn copyFiltered(allocator: std.mem.Allocator, source: []const u8, destination: []const u8, rules: *const publish_ignore.IgnoreRules) !void {
    try io_helper.makePath(destination);
    try copyDirectory(allocator, source, destination, "", rules);
}

fn copyDirectory(allocator: std.mem.Allocator, source: []const u8, destination: []const u8, relative: []const u8, rules: *const publish_ignore.IgnoreRules) anyerror!void {
    const source_dir = try std.fs.path.join(allocator, &.{ source, relative });
    defer allocator.free(source_dir);
    var directory = try io_helper.openDirForIteration(source_dir);
    defer directory.close();
    var iterator = directory.iterate();
    while (try iterator.next()) |entry| {
        const path = if (relative.len == 0)
            try allocator.dupe(u8, entry.name)
        else
            try std.fmt.allocPrint(allocator, "{s}/{s}", .{ relative, entry.name });
        defer allocator.free(path);
        // Do not stat or read an excluded entry when its kind is already known.
        if (entry.kind != .unknown and rules.isIgnored(path, entry.kind == .directory)) continue;
        const from = try std.fs.path.join(allocator, &.{ source, path });
        defer allocator.free(from);
        const info = try io_helper.cwd().statFile(io_helper.io, from, .{ .follow_symlinks = false });
        if (rules.isIgnored(path, info.kind == .directory)) continue;
        const to = try std.fs.path.join(allocator, &.{ destination, path });
        defer allocator.free(to);
        switch (info.kind) {
            .directory => {
                try io_helper.makePath(to);
                try copyDirectory(allocator, source, destination, path, rules);
                // Apply directory modes after copying its children, including
                // directories whose source permissions disallow writes.
                if (comptime io_helper.File.Permissions.has_executable_bit)
                    try io_helper.cwd().setFilePermissions(io_helper.io, to, .fromMode(info.permissions.toMode() & 0o777), .{});
            },
            .file => try io_helper.copyFile(from, to),
            .sym_link => {
                const target = try io_helper.readLinkAlloc(allocator, from);
                defer allocator.free(target);
                const target_info = io_helper.cwd().statFile(io_helper.io, from, .{}) catch null;
                try io_helper.cwd().symLink(io_helper.io, target, to, .{
                    .is_directory = if (target_info) |resolved| resolved.kind == .directory else false,
                });
            },
            // Sockets/devices/FIFOs are not publication archive members.
            else => {},
        }
    }
}
