//! Apply package.json bin semantics only to the owned publication stage.
const std = @import("std");
const io_helper = @import("../../io_helper.zig");

pub fn stagedPath(allocator: std.mem.Allocator, package_root: []const u8, name: []const u8) ![]const u8 {
    const path = try stagedEntryPath(allocator, package_root, name);
    errdefer allocator.free(path);
    if (std.mem.eql(u8, path, package_root)) return error.InvalidBinTarget;
    return path;
}

/// `files` may select the package directory itself; executable targets may not.
pub fn stagedEntryPath(allocator: std.mem.Allocator, package_root: []const u8, name: []const u8) ![]const u8 {
    if (name.len == 0 or std.fs.path.isAbsolute(name)) return error.InvalidBinTarget;
    const path = try std.fs.path.resolve(allocator, &.{ package_root, name });
    errdefer allocator.free(path);
    if (!std.mem.eql(u8, path, package_root) and !try withinPackage(allocator, package_root, path)) return error.InvalidBinTarget;
    return path;
}

fn withinPackage(allocator: std.mem.Allocator, root: []const u8, target: []const u8) !bool {
    const relative = try std.fs.path.relative(allocator, root, null, root, target);
    defer allocator.free(relative);
    return relative.len > 0 and !std.fs.path.isAbsolute(relative) and
        !std.mem.eql(u8, relative, "..") and !std.mem.startsWith(u8, relative, ".." ++ std.fs.path.sep_str);
}

fn validatedTarget(allocator: std.mem.Allocator, package_root: []const u8, name: []const u8) ![]const u8 {
    const path = try stagedPath(allocator, package_root, name);
    defer allocator.free(path);
    const actual = try io_helper.cwd().realPathFileAlloc(io_helper.io, path, allocator);
    defer allocator.free(actual);
    // Internal bin links are valid, but never chmod a target outside our stage.
    if (!try withinPackage(allocator, package_root, actual)) return error.InvalidBinTarget;
    const file = try io_helper.openFileAbsolute(actual, .{});
    defer file.close(io_helper.io);
    if ((try file.stat(io_helper.io)).kind != .file) return error.InvalidBinTarget;
    // realPathFileAlloc owns a sentinel byte; the public target API owns plain
    // slices, whose callers free exactly len bytes.
    return allocator.dupe(u8, actual);
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
    const bins = try targets(allocator, staging_base, bytes);
    defer {
        for (bins) |path| allocator.free(path);
        allocator.free(bins);
    }
    if (comptime io_helper.File.Permissions.has_executable_bit) {
        for (bins) |path| {
            const file = try io_helper.openFileAbsolute(path, .{});
            defer file.close(io_helper.io);
            try file.setPermissions(io_helper.io, io_helper.File.Permissions.fromMode(0o755));
        }
    }
}

/// Owned canonical regular-file targets, including targets of internal bin links.
pub fn targets(allocator: std.mem.Allocator, staging_base: []const u8, bytes: []const u8) ![][]const u8 {
    var paths: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (paths.items) |path| allocator.free(path);
        paths.deinit(allocator);
    }
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidPackageConfig;
    const bin = parsed.value.object.get("bin") orelse return paths.toOwnedSlice(allocator);
    const package_path = try std.fs.path.join(allocator, &.{ staging_base, "package" });
    defer allocator.free(package_path);
    const package_root = try io_helper.cwd().realPathFileAlloc(io_helper.io, package_path, allocator);
    defer allocator.free(package_root);
    switch (bin) {
        .string => |name| {
            const path = try validatedTarget(allocator, package_root, name);
            errdefer allocator.free(path);
            try paths.append(allocator, path);
        },
        .object => |commands| for (commands.values()) |value| {
            if (value == .string) {
                const path = try validatedTarget(allocator, package_root, value.string);
                errdefer allocator.free(path);
                try paths.append(allocator, path);
            }
        },
        else => {},
    }
    return paths.toOwnedSlice(allocator);
}

test "pack archive: bin targets retain their allocation shape across the public slice boundary" {
    const allocator = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    try temporary.dir.createDirPath(io_helper.io, "package");
    try temporary.dir.writeFile(io_helper.io, .{ .sub_path = "package/cli", .data = "#!/bin/sh\n" });
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const root = buffer[0..try temporary.dir.realPathFile(io_helper.io, ".", &buffer)];
    const bins = try targets(allocator, root, "{\"bin\":{\"fixture\":\"./cli\"}}");
    // The returned API deliberately owns ordinary slices. A sentinel allocation
    // erased to []const u8 must not cross this boundary and be freed one byte short.
    defer {
        for (bins) |path| allocator.free(path);
        allocator.free(bins);
    }
    try std.testing.expectEqual(@as(usize, 1), bins.len);
}
