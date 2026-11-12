const std = @import("std");
const builtin = @import("builtin");
const io_helper = @import("../../io_helper.zig");
const publish_bins = @import("publish_bins.zig");
const style = @import("../style.zig");

pub fn checkResult(allocator: std.mem.Allocator, result: io_helper.ChildRunResult) !void {
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    if (result.term != .exited or result.term.exited != 0) {
        style.print("Error: package archive creation failed: {s}\n", .{result.stderr});
        return error.TarballCreationFailed;
    }
}

/// tar treats a colon before the first slash as a remote-host separator.
/// Native Windows drive paths therefore cannot be passed as archive names.
/// Both publication paths create the archive beside their owned stage.
pub fn outputPath(allocator: std.mem.Allocator, stage: []const u8, archive: []const u8) ![]u8 {
    const relative = try std.fs.path.relative(allocator, stage, null, stage, archive);
    defer allocator.free(relative);
    if (std.fs.path.isAbsolute(relative)) return error.InvalidArchiveDestination;
    if (builtin.os.tag == .windows) std.mem.replaceScalar(u8, relative, '\\', '/');
    // Also keep colons and leading dashes in a relative filename local.
    return std.fmt.allocPrint(allocator, "./{s}", .{relative});
}

/// Windows has no POSIX executable bit to chmod. Write portable tar metadata
/// directly, so declared text bins receive the same mode as script/native bins.
pub fn packPortable(allocator: std.mem.Allocator, stage: []const u8, archive: []const u8, config: []const u8) !void {
    const bins = try publish_bins.targets(allocator, stage, config);
    defer {
        for (bins) |path| allocator.free(path);
        allocator.free(bins);
    }
    var executable = std.StringHashMap(void).init(allocator);
    defer executable.deinit();
    for (bins) |path| try executable.put(path, {});
    const package_path = try std.fs.path.join(allocator, &.{ stage, "package" });
    defer allocator.free(package_path);
    const root = try io_helper.cwd().realPathFileAlloc(io_helper.io, package_path, allocator);
    defer allocator.free(root);
    const output = try io_helper.createFile(archive, .{ .truncate = true });
    errdefer io_helper.deleteFile(archive) catch {};
    defer io_helper.closeFile(output);
    const output_buffer = try allocator.alloc(u8, 64 * 1024);
    defer allocator.free(output_buffer);
    var output_writer = output.writer(io_helper.io, output_buffer);
    const window = try allocator.alloc(u8, std.compress.flate.max_window_len);
    defer allocator.free(window);
    const compressor = try allocator.create(std.compress.flate.Compress);
    defer allocator.destroy(compressor);
    compressor.* = try .init(&output_writer.interface, window, .gzip, std.compress.flate.Compress.Options.level_6);
    var tar: std.tar.Writer = .{ .underlying_writer = &compressor.writer };
    const input_buffer = try allocator.alloc(u8, 32 * 1024);
    defer allocator.free(input_buffer);
    var tree: Tree = .{ .allocator = allocator, .tar = &tar, .executable = &executable, .input_buffer = input_buffer };
    try tree.write(root, "package");
    try tar.finishPedantically();
    try compressor.finish();
    try output_writer.interface.flush();
}

const Tree = struct {
    allocator: std.mem.Allocator,
    tar: *std.tar.Writer,
    executable: *std.StringHashMap(void),
    input_buffer: []u8,

    fn write(self: *Tree, directory: []const u8, name: []const u8) anyerror!void {
        try self.tar.writeDir(name, .{ .mode = 0o755 });
        var dir = try io_helper.openDirForIteration(directory);
        defer dir.close();
        const Entry = struct { name: []const u8, kind: io_helper.DirEntry.Kind };
        var entries: std.ArrayList(Entry) = .empty;
        defer {
            for (entries.items) |entry| self.allocator.free(entry.name);
            entries.deinit(self.allocator);
        }
        var iterator = dir.iterate();
        while (try iterator.next()) |entry| {
            const owned_name = try self.allocator.dupe(u8, entry.name);
            errdefer self.allocator.free(owned_name);
            try entries.append(self.allocator, .{ .name = owned_name, .kind = entry.kind });
        }
        std.mem.sort(Entry, entries.items, {}, struct {
            fn lessThan(_: void, a: Entry, b: Entry) bool {
                return std.mem.lessThan(u8, a.name, b.name);
            }
        }.lessThan);
        for (entries.items) |entry| {
            const source = try std.fs.path.join(self.allocator, &.{ directory, entry.name });
            defer self.allocator.free(source);
            const member = try std.fmt.allocPrint(self.allocator, "{s}/{s}", .{ name, entry.name });
            defer self.allocator.free(member);
            switch (entry.kind) {
                .directory => try self.write(source, member),
                .file => {
                    const file = try io_helper.openFileAbsolute(source, .{});
                    defer file.close(io_helper.io);
                    const stat = try file.stat(io_helper.io);
                    const actual = try io_helper.cwd().realPathFileAlloc(io_helper.io, source, self.allocator);
                    defer self.allocator.free(actual);
                    const mode: u32 = if (self.executable.contains(actual)) 0o755 else if (comptime io_helper.File.Permissions.has_executable_bit) @intCast(stat.permissions.toMode() & 0o777) else 0o644;
                    var reader = file.reader(io_helper.io, self.input_buffer);
                    try self.tar.writeFileStream(member, stat.size, &reader.interface, .{ .mode = mode });
                },
                .sym_link => {
                    const target = try io_helper.readLinkAlloc(self.allocator, source);
                    defer self.allocator.free(target);
                    if (target.len > 100) {
                        var header: std.tar.Writer.Header = .init(.gnu_long_link);
                        try header.setPath("", "././@LongLink");
                        try header.setSize(target.len + 1);
                        try header.write(self.tar.underlying_writer);
                        try self.tar.underlying_writer.writeAll(target);
                        try self.tar.underlying_writer.splatByteAll(0, 512 - target.len % 512);
                    }
                    try self.tar.writeLink(member, target[0..@min(target.len, 100)], .{});
                },
                else => return error.UnsupportedPackageEntry,
            }
        }
    }
};
