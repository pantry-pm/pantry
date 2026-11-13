// Explicitly import activation fixtures so their public-interface tests run in CI.
test {
    _ = @import("install/symlink.zig");
    _ = @import("install/native_apps.zig");
    _ = @import("install/runtime_environment.zig");
}

test "native activation: declared runtime environment follows the package and keeps payload bytes" {
    const std = @import("std");
    const io_helper = @import("io_helper.zig");
    const activation = @import("install/symlink.zig");
    if (@import("builtin").os.tag == .windows) return error.SkipZigTest;
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const length = try tmp.dir.realPathFile(io_helper.io, ".", &buffer);
    const root = buffer[0..length];
    try tmp.dir.createDirPath(io_helper.io, "tree with 'quotes $d/packages/runtime.invalid/v1.0.0/bin");
    try tmp.dir.createDirPath(io_helper.io, "tree with 'quotes $d/packages/runtime.invalid/v1.0.0/share/pantry");
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "tree with 'quotes $d/packages/runtime.invalid/v1.0.0/share/value", .data = "runtime-data-ok\n" });
    const runtime_metadata = "{\"version\":1,\"environment\":[{\"name\":\"PANTRY_RESOURCE_FILE\",\"value\":\"{{prefix}}/share/value\"},{\"name\":\"PANTRY_LITERAL\",\"value\":\"quote' \\\" $d $(printf injected) `printf injected`\"}]}";
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "tree with 'quotes $d/packages/runtime.invalid/v1.0.0/share/pantry/runtime.json", .data = runtime_metadata });
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "probe.c", .data =
        \\#include <stdio.h>
        \\#include <stdlib.h>
        \\int main(int argc, char **argv) {
        \\  const char *path = getenv("PANTRY_RESOURCE_FILE");
        \\  if (!path) return 2;
        \\  FILE *file = fopen(path, "r");
        \\  if (!file) return 3;
        \\  char value[128];
        \\  if (!fgets(value, sizeof(value), file)) return 4;
        \\  fclose(file);
        \\  fputs(value, stdout);
        \\  const char *literal = getenv("PANTRY_LITERAL");
        \\  if (!literal) return 5;
        \\  puts(literal);
        \\  if (argc > 1) puts(argv[1]);
        \\  return 0;
        \\}
        \\
    });
    const tree = try std.fs.path.join(allocator, &.{ root, "tree with 'quotes $d" });
    defer allocator.free(tree);
    const source = try std.fs.path.join(allocator, &.{ root, "probe.c" });
    defer allocator.free(source);
    const provider = try std.fs.path.join(allocator, &.{ tree, "packages/runtime.invalid/v1.0.0/bin/probe" });
    defer allocator.free(provider);
    const compiled = try io_helper.childRun(allocator, &.{ "clang", source, "-o", provider });
    defer allocator.free(compiled.stdout);
    defer allocator.free(compiled.stderr);
    try std.testing.expect(compiled.term == .exited and compiled.term.exited == 0);
    const before = try @import("install/extractor.zig").computeChecksum(allocator, provider);
    defer allocator.free(before);
    try activation.createBinarySymlink(allocator, "runtime.invalid", "1.0.0", "probe", tree);
    const command = try std.fs.path.join(allocator, &.{ tree, "bin/probe" });
    defer allocator.free(command);
    const result = try io_helper.childRun(allocator, &.{ command, "argument with spaces" });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    try std.testing.expect(result.term == .exited and result.term.exited == 0);
    try std.testing.expectEqualStrings("runtime-data-ok\nquote' \" $d $(printf injected) `printf injected`\nargument with spaces\n", result.stdout);
    const overridden = try io_helper.childRun(allocator, &.{ "env", "PANTRY_LITERAL=caller value", command });
    defer allocator.free(overridden.stdout);
    defer allocator.free(overridden.stderr);
    try std.testing.expect(overridden.term == .exited and overridden.term.exited == 0);
    try std.testing.expectEqualStrings("runtime-data-ok\ncaller value\n", overridden.stdout);
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "tree with 'quotes $d/packages/runtime.invalid/v1.0.0/share/pantry/runtime.json", .data = "{\"version\":1,\"environment\":[{\"name\":\"BAD-NAME\",\"value\":\"value\"}]}" });
    try std.testing.expectError(error.InvalidPackageRuntimeEnvironment, activation.createBinarySymlink(allocator, "runtime.invalid", "1.0.0", "probe", tree));
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "tree with 'quotes $d/packages/runtime.invalid/v1.0.0/share/pantry/runtime.json", .data = runtime_metadata });
    const after = try @import("install/extractor.zig").computeChecksum(allocator, provider);
    defer allocator.free(after);
    try std.testing.expectEqualStrings(before, after);
    const resolved = activation.resolvedActivationTarget(allocator, command) orelse return error.MissingActivationTarget;
    defer allocator.free(resolved);
    try std.testing.expectEqualStrings(provider, resolved);
    const moved_tree = try std.fs.path.join(allocator, &.{ root, "moved tree" });
    defer allocator.free(moved_tree);
    try io_helper.rename(tree, moved_tree);
    const moved = try std.fs.path.join(allocator, &.{ moved_tree, "bin/probe" });
    defer allocator.free(moved);
    const relocated = try io_helper.childRun(allocator, &.{moved});
    defer allocator.free(relocated.stdout);
    defer allocator.free(relocated.stderr);
    try std.testing.expect(relocated.term == .exited and relocated.term.exited == 0);
    try std.testing.expectEqualStrings("runtime-data-ok\nquote' \" $d $(printf injected) `printf injected`\n", relocated.stdout);
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
