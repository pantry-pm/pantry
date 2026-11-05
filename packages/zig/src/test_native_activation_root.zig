// Explicitly import activation fixtures so their public-interface tests run in CI.
test {
    _ = @import("install/symlink.zig");
    _ = @import("install/native_apps.zig");
}

test "native activation: final project repair retains canonical package interfaces" {
    const std = @import("std");
    const io_helper = @import("io_helper.zig");
    if (@import("builtin").os.tag == .windows) return error.SkipZigTest;
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const length = try tmp.dir.realPathFile(io_helper.io, ".", &buffer);
    const root = buffer[0..length];
    try tmp.dir.createDirPath(io_helper.io, "pantry/gnu.org/gettext/v0.21.1/bin");
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "pantry/gnu.org/gettext/v0.21.1/bin/gettext.sh", .data = "PANTRY_REPAIR_SOURCE=complete\n" });
    const activation = try std.fs.path.join(allocator, &.{ root, "pantry/.bin/gettext.sh" });
    defer allocator.free(activation);
    for (0..2) |_| {
        @import("cli/commands/install/helpers.zig").ensureBinSymlinks(allocator, root, "pantry");
        const result = try io_helper.childRun(allocator, &.{ "/bin/sh", "-c", ". \"$1\"; test \"$PANTRY_REPAIR_SOURCE\" = complete", "sh", activation });
        defer allocator.free(result.stdout);
        defer allocator.free(result.stderr);
        try std.testing.expect(result.term == .exited and result.term.exited == 0);
    }
}
