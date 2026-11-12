const std = @import("std");
const builtin = @import("builtin");

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
