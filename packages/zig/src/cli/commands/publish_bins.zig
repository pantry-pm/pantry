//! Apply package.json bin semantics only to the owned publication stage.
const std = @import("std");
const io_helper = @import("../../io_helper.zig");

pub fn stagedPath(allocator: std.mem.Allocator, package_root: []const u8, name: []const u8) ![]const u8 {
    if (name.len == 0 or std.fs.path.isAbsolute(name)) return error.InvalidBinTarget;
    const path = try std.fs.path.resolve(allocator, &.{ package_root, name });
    errdefer allocator.free(path);
    if (!try withinPackage(allocator, package_root, path)) return error.InvalidBinTarget;
    return path;
}

fn withinPackage(allocator: std.mem.Allocator, root: []const u8, target: []const u8) !bool {
    const relative = try std.fs.path.relative(allocator, root, null, root, target);
    defer allocator.free(relative);
    return relative.len > 0 and !std.fs.path.isAbsolute(relative) and
        !std.mem.eql(u8, relative, "..") and !std.mem.startsWith(u8, relative, ".." ++ std.fs.path.sep_str);
}

fn makeStagedBinExecutable(allocator: std.mem.Allocator, package_root: []const u8, name: []const u8) !void {
    const path = try stagedPath(allocator, package_root, name);
    defer allocator.free(path);
    const actual = try io_helper.cwd().realPathFileAlloc(io_helper.io, path, allocator);
    defer allocator.free(actual);
    // Internal bin links are valid, but never chmod a target outside our stage.
    if (!try withinPackage(allocator, package_root, actual)) return error.InvalidBinTarget;
    const file = try io_helper.openFileAbsolute(actual, .{});
    defer file.close(io_helper.io);
    if ((try file.stat(io_helper.io)).kind != .file) return error.InvalidBinTarget;
    if (comptime io_helper.File.Permissions.has_executable_bit)
        try file.setPermissions(io_helper.io, io_helper.File.Permissions.fromMode(0o755));
}

pub fn normalize(allocator: std.mem.Allocator, staging_base: []const u8) !void {
    const manifest_path = try std.fs.path.join(allocator, &.{ staging_base, "package", "package.json" });
    defer allocator.free(manifest_path);
    const bytes = try io_helper.readFileAlloc(allocator, manifest_path, 10 * 1024 * 1024);
    defer allocator.free(bytes);
    try normalizeWithConfig(allocator, staging_base, bytes);
}

/// Pantry publications may select pantry.json instead of package.json.
pub fn normalizeWithConfig(allocator: std.mem.Allocator, staging_base: []const u8, bytes: []const u8) !void {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidPackageConfig;
    const bin = parsed.value.object.get("bin") orelse return;
    const package_path = try std.fs.path.join(allocator, &.{ staging_base, "package" });
    defer allocator.free(package_path);
    const package_root = try io_helper.cwd().realPathFileAlloc(io_helper.io, package_path, allocator);
    defer allocator.free(package_root);
    switch (bin) {
        .string => |name| try makeStagedBinExecutable(allocator, package_root, name),
        .object => |commands| for (commands.values()) |value| {
            if (value == .string) try makeStagedBinExecutable(allocator, package_root, value.string);
        },
        else => {},
    }
}
