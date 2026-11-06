//! Read only a service's explicitly requested key from its project's .env.
//! Never execute/interpolate the file or export unrelated application secrets.
const std = @import("std");
const io_helper = @import("../io_helper.zig");

pub fn valueFromDotEnv(content: []const u8, key: []const u8) ?[]const u8 {
    var found: ?[]const u8 = null;
    var lines = std.mem.splitScalar(u8, content, '\n');
    while (lines.next()) |line| {
        var s = std.mem.trim(u8, line, " \t\r");
        if (s.len == 0 or s[0] == '#') continue;
        if (std.mem.startsWith(u8, s, "export ")) s = std.mem.trimStart(u8, s[7..], " \t");
        const eq = std.mem.indexOfScalar(u8, s, '=') orelse continue;
        if (!std.mem.eql(u8, std.mem.trim(u8, s[0..eq], " \t"), key)) continue;
        var value = std.mem.trim(u8, s[eq + 1 ..], " \t\r");
        if (value.len > 0 and (value[0] == '"' or value[0] == '\'')) {
            const end = std.mem.indexOfScalarPos(u8, value, 1, value[0]) orelse return null;
            const rest = std.mem.trim(u8, value[end + 1 ..], " \t");
            if (rest.len > 0 and rest[0] != '#') return null;
            value = value[1..end];
        } else if (std.mem.indexOf(u8, value, " #")) |comment| {
            value = std.mem.trimEnd(u8, value[0..comment], " \t");
        }
        found = value;
    }
    return found;
}

/// Caller owns the value. Explicit process environment wins, even when empty.
/// A missing project/file/key preserves the service's existing default.
pub fn get(allocator: std.mem.Allocator, key: []const u8, project_root: ?[]const u8) !?[]const u8 {
    if (io_helper.getEnvVarOwned(allocator, key) catch null) |value| return value;
    const root = project_root orelse return null;
    const path = try std.fs.path.join(allocator, &.{ root, ".env" });
    defer allocator.free(path);
    const content = io_helper.readFileAlloc(allocator, path, 1024 * 1024) catch return null;
    defer allocator.free(content);
    const value = valueFromDotEnv(content, key) orelse return null;
    return try allocator.dupe(u8, value);
}

test "service environment reads exact keys, quoted hashes, comments and last assignments" {
    try std.testing.expectEqualStrings("last#key", valueFromDotEnv(
        "OTHER_KEY=private\nTYPESENSE_API_KEY_OLD=wrong\nTYPESENSE_API_KEY=first\n export TYPESENSE_API_KEY = 'last#key' # local\r\n",
        "TYPESENSE_API_KEY",
    ).?);
    try std.testing.expectEqualStrings("key", valueFromDotEnv("TYPESENSE_API_KEY=key # comment", "TYPESENSE_API_KEY").?);
    try std.testing.expectEqualStrings("", valueFromDotEnv("TYPESENSE_API_KEY=", "TYPESENSE_API_KEY").?);
    try std.testing.expect(valueFromDotEnv("OTHER_KEY=secret", "TYPESENSE_API_KEY") == null);
    try std.testing.expect(valueFromDotEnv("TYPESENSE_API_KEY='unterminated", "TYPESENSE_API_KEY") == null);
    try std.testing.expect(valueFromDotEnv("TYPESENSE_API_KEY='key' trailing", "TYPESENSE_API_KEY") == null);
}

test "service environment reads the selected project and keeps explicit process precedence" {
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = path_buf[0..try tmp.dir.realPath(io_helper.io, &path_buf)];
    const file = try tmp.dir.createFile(io_helper.io, ".env", .{});
    try io_helper.writeAllToFile(file, "PANTRY_SERVICE_TEST_FILE_KEY=local-value\nPATH=wrong-project-path\nUNRELATED_SECRET=private\n");
    file.close(io_helper.io);
    const local = (try get(allocator, "PANTRY_SERVICE_TEST_FILE_KEY", root)).?;
    defer allocator.free(local);
    try std.testing.expectEqualStrings("local-value", local);
    try std.testing.expect(try get(allocator, "PANTRY_SERVICE_TEST_MISSING_KEY", root) == null);
    try std.testing.expect(try get(allocator, "PANTRY_SERVICE_TEST_FILE_KEY", null) == null);
    const inherited = (try get(allocator, "PATH", root)).?;
    defer allocator.free(inherited);
    try std.testing.expect(!std.mem.eql(u8, "wrong-project-path", inherited));
}
