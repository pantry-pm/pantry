const std = @import("std");

pub const Variable = struct { name: []const u8, value: []const u8 };
pub const Metadata = struct {
    version: u32 = 1,
    target: []const u8,
    arguments: []const []const u8 = &.{},
    environment: []const Variable,
};
pub const marker = "#!/bin/sh\n# pantry-runtime-v1 ";

pub fn validate(variable: Variable) !void {
    if (variable.name.len == 0) return error.InvalidPackageRuntimeEnvironment;
    for (variable.name, 0..) |ch, index| {
        if (!std.ascii.isAlphabetic(ch) and ch != '_' and !(index > 0 and std.ascii.isDigit(ch)))
            return error.InvalidPackageRuntimeEnvironment;
    }
    if (std.mem.indexOfScalar(u8, variable.value, 0) != null) return error.InvalidPackageRuntimeEnvironment;
    var remaining = variable.value;
    while (std.mem.indexOf(u8, remaining, "{{prefix}}")) |offset| {
        const segment = remaining[0..offset];
        if (std.mem.indexOf(u8, segment, "{{") != null or std.mem.indexOf(u8, segment, "}}") != null)
            return error.InvalidPackageRuntimeEnvironment;
        remaining = remaining[offset + "{{prefix}}".len ..];
    }
    if (std.mem.indexOf(u8, remaining, "{{") != null or std.mem.indexOf(u8, remaining, "}}") != null)
        return error.InvalidPackageRuntimeEnvironment;
}

fn literal(allocator: std.mem.Allocator, out: *std.ArrayList(u8), value: []const u8) !void {
    try out.append(allocator, '\'');
    for (value) |ch| {
        if (ch == '\'') try out.appendSlice(allocator, "'\"'\"'") else try out.append(allocator, ch);
    }
    try out.append(allocator, '\'');
}

fn pathWord(allocator: std.mem.Allocator, out: *std.ArrayList(u8), path: []const u8) !void {
    if (!std.fs.path.isAbsolute(path)) try out.appendSlice(allocator, "\"$d/\"");
    try literal(allocator, out, path);
}

fn valueWord(allocator: std.mem.Allocator, out: *std.ArrayList(u8), value: []const u8, prefix: []const u8) !void {
    var remaining = value;
    while (std.mem.indexOf(u8, remaining, "{{prefix}}")) |offset| {
        const start = if (offset > 0 and remaining[offset - 1] == '$') offset - 1 else offset;
        try literal(allocator, out, remaining[0..start]);
        try pathWord(allocator, out, prefix);
        remaining = remaining[offset + "{{prefix}}".len ..];
    }
    try literal(allocator, out, remaining);
}

/// The encoded declaration lets ownership readers verify the entire generated
/// script without evaluating shell text or accepting an arbitrary wrapper.
pub fn script(allocator: std.mem.Allocator, metadata: Metadata, locate_self: []const u8) ![]u8 {
    if (metadata.version != 1 or metadata.environment.len == 0 or std.mem.indexOfScalar(u8, metadata.target, 0) != null)
        return error.InvalidPackageRuntimeEnvironment;
    const directory = std.fs.path.dirname(metadata.target) orelse return error.InvalidPackageRuntimeEnvironment;
    const prefix = std.fs.path.dirname(directory) orelse return error.InvalidPackageRuntimeEnvironment;
    if (!std.mem.eql(u8, std.fs.path.basename(directory), "bin") and !std.mem.eql(u8, std.fs.path.basename(directory), "sbin"))
        return error.InvalidPackageRuntimeEnvironment;
    const encoded = try std.json.Stringify.valueAlloc(allocator, metadata, .{});
    defer allocator.free(encoded);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, marker);
    try out.appendSlice(allocator, encoded);
    try out.append(allocator, '\n');
    try out.appendSlice(allocator, locate_self);
    try out.appendSlice(allocator, "case $d in /*) ;; *) d=$PWD/$d ;; esac\n");
    for (metadata.environment, 0..) |variable, index| {
        try validate(variable);
        for (metadata.environment[0..index]) |earlier| {
            if (std.mem.eql(u8, earlier.name, variable.name)) return error.InvalidPackageRuntimeEnvironment;
        }
        try out.appendSlice(allocator, "if [ -z \"${");
        try out.appendSlice(allocator, variable.name);
        try out.appendSlice(allocator, ":-}\" ]; then export ");
        try out.appendSlice(allocator, variable.name);
        try out.append(allocator, '=');
        try valueWord(allocator, &out, variable.value, prefix);
        try out.appendSlice(allocator, "; fi\n");
    }
    try out.appendSlice(allocator, "exec ");
    try pathWord(allocator, &out, metadata.target);
    for (metadata.arguments) |argument| {
        if (std.mem.indexOfScalar(u8, argument, 0) != null) return error.InvalidPackageRuntimeEnvironment;
        try out.append(allocator, ' ');
        try literal(allocator, &out, argument);
    }
    try out.appendSlice(allocator, " \"$@\"\n");
    return out.toOwnedSlice(allocator);
}

pub fn activationTarget(allocator: std.mem.Allocator, content: []const u8, locate_self: []const u8) ?[]u8 {
    if (!std.mem.startsWith(u8, content, marker)) return null;
    const end = std.mem.indexOfScalarPos(u8, content, marker.len, '\n') orelse return null;
    const parsed = std.json.parseFromSlice(Metadata, allocator, content[marker.len..end], .{}) catch return null;
    defer parsed.deinit();
    const expected = script(allocator, parsed.value, locate_self) catch return null;
    defer allocator.free(expected);
    if (!std.mem.eql(u8, expected, content)) return null;
    return allocator.dupe(u8, parsed.value.target) catch null;
}

test "runtime activation metadata resolves only the exact generated script" {
    const allocator = std.testing.allocator;
    const metadata: Metadata = .{ .target = "../package/v1/bin/program", .environment = &.{.{ .name = "PACKAGE_DATA", .value = "{{prefix}}/share/data" }} };
    const content = try script(allocator, metadata, "d=${0%/*}\n");
    defer allocator.free(content);
    const target = activationTarget(allocator, content, "d=${0%/*}\n") orelse return error.MissingActivationTarget;
    defer allocator.free(target);
    try std.testing.expectEqualStrings(metadata.target, target);
    const modified = try std.mem.concat(allocator, u8, &.{ content, "touch unexpected\n" });
    defer allocator.free(modified);
    try std.testing.expect(activationTarget(allocator, modified, "d=${0%/*}\n") == null);
    try std.testing.expectError(error.InvalidPackageRuntimeEnvironment, script(allocator, .{ .target = metadata.target, .environment = &.{.{ .name = "BAD-NAME", .value = "value" }} }, ""));
    try std.testing.expectError(error.InvalidPackageRuntimeEnvironment, script(allocator, .{ .target = metadata.target, .environment = &.{.{ .name = "VALID", .value = "{{unsupported}}/data" }} }, ""));
}
