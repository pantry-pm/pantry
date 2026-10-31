//! Deprecated packages.
//!
//! A package's owner can deprecate it (`pantry deprecate`). The registry keeps
//! serving every version and adds npm's `deprecated: "<message>"` to the
//! metadata. An install warns about it, once per package and version, and goes
//! on: deprecation never fails an install.
//!
//!   warn: @hq/kit-probe@1.0.0 is deprecated: Use @hq/kit instead

const std = @import("std");
const io_helper = @import("../io_helper.zig");

/// What a deprecation says when the registry gives no message (`true`).
pub const default_message = "This package is deprecated";

/// Longest message printed; the rest is cut with an ellipsis.
pub const max_printed_len = 300;

/// The `deprecated` field of a metadata document, borrowed from it. npm's
/// convention: a non-empty string is the message, an empty string means "not
/// deprecated". `true` (a looser registry) gets the default message.
pub fn fromMetadata(obj: std.json.ObjectMap) ?[]const u8 {
    const value = obj.get("deprecated") orelse return null;
    return switch (value) {
        .string => |s| if (std.mem.trim(u8, s, &std.ascii.whitespace).len > 0) s else null,
        .bool => |b| if (b) default_message else null,
        else => null,
    };
}

/// `warn: <name>@<version> is deprecated: <message>` as one line: control
/// characters become spaces, whitespace runs collapse, and a long message is
/// cut, so a registry can't print more than one line or move the cursor.
pub fn formatWarning(allocator: std.mem.Allocator, name: []const u8, version: []const u8, message: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.print(allocator, "warn: {s}@{s} is deprecated: ", .{ name, version });

    var written: usize = 0;
    var pending_space = false;
    for (message) |c| {
        const blank = c < 0x20 or c == 0x7f or c == ' ';
        if (blank) {
            pending_space = written > 0;
            continue;
        }
        if (written >= max_printed_len) {
            try out.appendSlice(allocator, "...");
            break;
        }
        if (pending_space) {
            try out.append(allocator, ' ');
            written += 1;
            pending_space = false;
        }
        try out.append(allocator, c);
        written += 1;
    }
    if (written == 0) try out.appendSlice(allocator, default_message);
    return out.toOwnedSlice(allocator);
}

var seen_mutex: io_helper.Mutex = .{};
var seen: std.StringHashMapUnmanaged(void) = .empty;

/// Print the warning to stderr, once per `name@version` for this process:
/// the resolver can reach the same package several times in one install.
pub fn warn(name: []const u8, version: []const u8, message: []const u8) void {
    const allocator = std.heap.page_allocator;
    const key = std.fmt.allocPrint(allocator, "{s}@{s}", .{ name, version }) catch return;
    {
        seen_mutex.lock();
        defer seen_mutex.unlock();
        const entry = seen.getOrPut(allocator, key) catch {
            allocator.free(key);
            return;
        };
        if (entry.found_existing) {
            allocator.free(key);
            return;
        }
    }
    const line = formatWarning(allocator, name, version, message) catch return;
    defer allocator.free(line);
    std.debug.print("{s}\n", .{line});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

fn parseObject(allocator: std.mem.Allocator, text: []const u8) !std.json.Parsed(std.json.Value) {
    return std.json.parseFromSlice(std.json.Value, allocator, text, .{});
}

test "deprecation: reads npm's deprecated field" {
    const cases = [_]struct { json: []const u8, want: ?[]const u8 }{
        .{ .json = "{\"deprecated\":\"Use @hq/kit instead\"}", .want = "Use @hq/kit instead" },
        .{ .json = "{\"deprecated\":\"\"}", .want = null },
        .{ .json = "{\"deprecated\":\"   \"}", .want = null },
        .{ .json = "{\"deprecated\":true}", .want = default_message },
        .{ .json = "{\"deprecated\":false}", .want = null },
        .{ .json = "{\"deprecated\":null}", .want = null },
        .{ .json = "{\"name\":\"x\"}", .want = null },
    };
    for (cases) |case| {
        const parsed = try parseObject(testing.allocator, case.json);
        defer parsed.deinit();
        const got = fromMetadata(parsed.value.object);
        if (case.want) |want| {
            try testing.expectEqualStrings(want, got.?);
        } else {
            try testing.expect(got == null);
        }
    }
}

test "deprecation: the warning is one clean line" {
    const line = try formatWarning(testing.allocator, "@hq/kit-probe", "1.2.3", "Use @hq/kit instead");
    defer testing.allocator.free(line);
    try testing.expectEqualStrings("warn: @hq/kit-probe@1.2.3 is deprecated: Use @hq/kit instead", line);

    const forged = try formatWarning(testing.allocator, "x", "1.0.0", "  gone\n\x1b[2Kinstalled ok\r\t ");
    defer testing.allocator.free(forged);
    try testing.expectEqualStrings("warn: x@1.0.0 is deprecated: gone [2Kinstalled ok", forged);
    try testing.expect(std.mem.indexOfScalar(u8, forged, '\n') == null);
    try testing.expect(std.mem.indexOfScalar(u8, forged, 0x1b) == null);

    const blank = try formatWarning(testing.allocator, "x", "1.0.0", "\n\n");
    defer testing.allocator.free(blank);
    try testing.expectEqualStrings("warn: x@1.0.0 is deprecated: " ++ default_message, blank);

    const long_message: [max_printed_len + 50]u8 = @splat('a');
    const cut = try formatWarning(testing.allocator, "x", "1.0.0", &long_message);
    defer testing.allocator.free(cut);
    try testing.expect(std.mem.endsWith(u8, cut, "a..."));
    try testing.expectEqual("warn: x@1.0.0 is deprecated: ".len + max_printed_len + 3, cut.len);
}
