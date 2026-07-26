const std = @import("std");

/// Strip comments from JSONC (JSON with Comments) content
/// Handles:
/// - Single-line comments: // comment
/// - Multi-line comments: /* comment */
/// - Preserves strings containing comment-like sequences
pub fn stripComments(allocator: std.mem.Allocator, jsonc: []const u8) ![]const u8 {
    var result = try std.ArrayList(u8).initCapacity(allocator, jsonc.len);
    errdefer result.deinit(allocator);

    var i: usize = 0;
    var in_string = false;
    var escape_next = false;

    while (i < jsonc.len) {
        const char = jsonc[i];

        // Handle escape sequences in strings
        if (in_string and escape_next) {
            try result.append(allocator, char);
            escape_next = false;
            i += 1;
            continue;
        }

        // Handle string boundaries
        if (char == '"' and !escape_next) {
            in_string = !in_string;
            try result.append(allocator, char);
            i += 1;
            continue;
        }

        // Handle escape character
        if (in_string and char == '\\') {
            escape_next = true;
            try result.append(allocator, char);
            i += 1;
            continue;
        }

        // If we're in a string, just copy the character
        if (in_string) {
            try result.append(allocator, char);
            i += 1;
            continue;
        }

        // Check for single-line comment
        if (char == '/' and i + 1 < jsonc.len and jsonc[i + 1] == '/') {
            // Skip until end of line
            i += 2;
            while (i < jsonc.len and jsonc[i] != '\n' and jsonc[i] != '\r') {
                i += 1;
            }
            // Keep the newline for formatting
            if (i < jsonc.len) {
                try result.append(allocator, jsonc[i]);
                i += 1;
            }
            continue;
        }

        // Check for multi-line comment
        if (char == '/' and i + 1 < jsonc.len and jsonc[i + 1] == '*') {
            // Skip until */
            i += 2;
            var found_end = false;
            while (i + 1 < jsonc.len) {
                if (jsonc[i] == '*' and jsonc[i + 1] == '/') {
                    i += 2;
                    found_end = true;
                    break;
                }
                i += 1;
            }
            if (!found_end) {
                // Unterminated comment - skip to end
                i = jsonc.len;
            }
            continue;
        }

        // Regular character - copy it
        try result.append(allocator, char);
        i += 1;
    }

    return result.toOwnedSlice(allocator);
}

/// Strip trailing commas from JSON content (e.g. `{"a": 1,}` → `{"a": 1}`)
/// Handles commas before `]` and `}`, skipping whitespace between them.
/// Preserves strings containing comma sequences.
pub fn stripTrailingCommas(allocator: std.mem.Allocator, json: []const u8) ![]const u8 {
    var result = try std.ArrayList(u8).initCapacity(allocator, json.len);
    errdefer result.deinit(allocator);

    var i: usize = 0;
    var in_string = false;
    var escape_next = false;

    while (i < json.len) {
        const char = json[i];

        if (in_string and escape_next) {
            try result.append(allocator, char);
            escape_next = false;
            i += 1;
            continue;
        }

        if (char == '"' and !escape_next) {
            in_string = !in_string;
            try result.append(allocator, char);
            i += 1;
            continue;
        }

        if (in_string and char == '\\') {
            escape_next = true;
            try result.append(allocator, char);
            i += 1;
            continue;
        }

        if (in_string) {
            try result.append(allocator, char);
            i += 1;
            continue;
        }

        // Outside strings: check if this comma is trailing
        if (char == ',') {
            // Look ahead past whitespace for ] or }
            var j = i + 1;
            while (j < json.len and (json[j] == ' ' or json[j] == '\t' or json[j] == '\n' or json[j] == '\r')) {
                j += 1;
            }
            if (j < json.len and (json[j] == ']' or json[j] == '}')) {
                // Skip the trailing comma
                i += 1;
                continue;
            }
        }

        try result.append(allocator, char);
        i += 1;
    }

    return result.toOwnedSlice(allocator);
}

test "stripComments - single line comment" {
    const allocator = std.testing.allocator;
    const input =
        \\{
        \\  // This is a comment
        \\  "name": "test"
        \\}
    ;
    const result = try stripComments(allocator, input);
    defer allocator.free(result);

    // Should not contain the comment
    try std.testing.expect(std.mem.indexOf(u8, result, "This is a comment") == null);
    // Should contain the name field
    try std.testing.expect(std.mem.indexOf(u8, result, "\"name\"") != null);
}

test "stripComments - multi line comment" {
    const allocator = std.testing.allocator;
    const input =
        \\{
        \\  /* This is a
        \\     multi-line comment */
        \\  "name": "test"
        \\}
    ;
    const result = try stripComments(allocator, input);
    defer allocator.free(result);

    // Should not contain the comment
    try std.testing.expect(std.mem.indexOf(u8, result, "multi-line comment") == null);
    // Should contain the name field
    try std.testing.expect(std.mem.indexOf(u8, result, "\"name\"") != null);
}

test "stripComments - preserve comment-like strings" {
    const allocator = std.testing.allocator;
    const input =
        \\{
        \\  "url": "https://example.com",
        \\  "comment": "This // is not a comment",
        \\  "note": "Neither /* is */ this"
        \\}
    ;
    const result = try stripComments(allocator, input);
    defer allocator.free(result);

    // All strings should be preserved
    try std.testing.expect(std.mem.indexOf(u8, result, "https://example.com") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "This // is not a comment") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "Neither /* is */ this") != null);
}

test "stripComments - escaped quotes in strings" {
    const allocator = std.testing.allocator;
    const input =
        \\{
        \\  // Real comment
        \\  "text": "She said \"hello\" // not a comment"
        \\}
    ;
    const result = try stripComments(allocator, input);
    defer allocator.free(result);

    // The string with escaped quotes should be preserved
    try std.testing.expect(std.mem.indexOf(u8, result, "She said \\\"hello\\\" // not a comment") != null);
    // The real comment should be gone
    try std.testing.expect(std.mem.indexOf(u8, result, "Real comment") == null);
}

test "stripComments - trailing comma comment" {
    const allocator = std.testing.allocator;
    const input =
        \\{
        \\  "name": "test", // trailing comma is ok
        \\  "version": "1.0.0"
        \\}
    ;
    const result = try stripComments(allocator, input);
    defer allocator.free(result);

    try std.testing.expect(std.mem.indexOf(u8, result, "trailing comma is ok") == null);
    try std.testing.expect(std.mem.indexOf(u8, result, "\"name\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "\"version\"") != null);
}

test "stripTrailingCommas - object trailing comma" {
    const allocator = std.testing.allocator;
    const input =
        \\{"a": 1, "b": 2,}
    ;
    const result = try stripTrailingCommas(allocator, input);
    defer allocator.free(result);

    // Should parse as valid JSON after stripping
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, result, .{});
    defer parsed.deinit();
    try std.testing.expect(parsed.value == .object);
}

test "stripTrailingCommas - array trailing comma" {
    const allocator = std.testing.allocator;
    const input =
        \\[1, 2, 3,]
    ;
    const result = try stripTrailingCommas(allocator, input);
    defer allocator.free(result);

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, result, .{});
    defer parsed.deinit();
    try std.testing.expect(parsed.value == .array);
    try std.testing.expectEqual(@as(usize, 3), parsed.value.array.items.len);
}

test "stripTrailingCommas - nested trailing commas" {
    const allocator = std.testing.allocator;
    const input =
        \\{
        \\  "deps": {
        \\    "stacks": "workspace:*",
        \\  },
        \\  "workspaces": [
        \\    "packages/*",
        \\  ]
        \\}
    ;
    const result = try stripTrailingCommas(allocator, input);
    defer allocator.free(result);

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, result, .{});
    defer parsed.deinit();
    try std.testing.expect(parsed.value == .object);
    try std.testing.expect(parsed.value.object.get("workspaces") != null);
}

test "stripComments preserves // in strings" {
    const allocator = std.testing.allocator;
    const input =
        \\{"url": "https://example.com/path"}
    ;
    const result = try stripComments(allocator, input);
    defer allocator.free(result);
    try std.testing.expect(std.mem.indexOf(u8, result, "https://example.com/path") != null);
}

test "stripTrailingCommas - preserves commas in strings" {
    const allocator = std.testing.allocator;
    const input =
        \\{"msg": "hello,}world", "x": 1,}
    ;
    const result = try stripTrailingCommas(allocator, input);
    defer allocator.free(result);

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, result, .{});
    defer parsed.deinit();
    const msg = parsed.value.object.get("msg").?.string;
    try std.testing.expectEqualStrings("hello,}world", msg);
}

/// Sets `"<name>": "<version>"` inside the `<section>` object, editing the
/// source text in place rather than reserializing it.
///
/// `pantry add` used to strip comments, parse, and write the tree back out.
/// That is lossless only for data: every comment and every formatting choice in
/// the file was discarded. On a `.jsonc` file — a format whose entire reason to
/// exist is comments — that turns adding one dependency into a rewrite of the
/// whole manifest.
///
/// This walks the raw bytes instead, touching only the one value (or inserting
/// one line), so everything else survives byte for byte.
///
/// Returns null when the shape is not something it can edit confidently: no
/// such section, unbalanced braces, a non-object section. Callers fall back to
/// the reserializing path, so a file this cannot handle is never made worse.
///
/// Caller owns the returned buffer.
pub fn setDependency(
    allocator: std.mem.Allocator,
    source: []const u8,
    section: []const u8,
    name: []const u8,
    version: []const u8,
) !?[]u8 {
    const section_body = findSectionBody(source, section) orelse {
        // The key exists but is not an object (an array, a string, …).
        // Creating another would leave a duplicate key, so give up and let the
        // caller decide.
        if (indexOfKey(source, 0, section) != null) return null;
        return createSection(allocator, source, section, name, version);
    };

    if (findKeyValueSpan(source, section_body, name)) |span| {
        // Present already: replace just the value token, quotes included.
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(allocator);
        try out.appendSlice(allocator, source[0..span.value_start]);
        try out.append(allocator, '"');
        try out.appendSlice(allocator, version);
        try out.append(allocator, '"');
        try out.appendSlice(allocator, source[span.value_end..]);
        return try out.toOwnedSlice(allocator);
    }

    // Absent: insert as the first entry, matching the indentation and comma
    // style of whatever is already there.
    const indent = detectEntryIndent(source, section_body);
    const has_entries = firstNonSpace(source[section_body.start..section_body.end]) != null;

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, source[0..section_body.start]);
    try out.append(allocator, '\n');
    try out.appendSlice(allocator, indent);
    try out.append(allocator, '"');
    try out.appendSlice(allocator, name);
    try out.appendSlice(allocator, "\": \"");
    try out.appendSlice(allocator, version);
    try out.append(allocator, '"');
    if (has_entries) try out.append(allocator, ',');
    try out.appendSlice(allocator, source[section_body.start..]);
    return try out.toOwnedSlice(allocator);
}

/// Adds `"<section>": { "<name>": "<version>" }` as the first member of the
/// root object.
///
/// Without this, `pantry add --dev` on a manifest that has no
/// `devDependencies` yet fell through to the reserializing path — which not
/// only dropped every comment but wrote the package at the ROOT of the
/// document rather than inside the section.
///
/// Returns null when the root is not an object.
fn createSection(
    allocator: std.mem.Allocator,
    source: []const u8,
    section: []const u8,
    name: []const u8,
    version: []const u8,
) !?[]u8 {
    const root_open = std.mem.indexOfScalar(u8, source, '{') orelse return null;
    // Anything before the first brace must be whitespace, or this is not a
    // plain JSON document and guessing would corrupt it.
    for (source[0..root_open]) |c| {
        if (c != ' ' and c != '\t' and c != '\n' and c != '\r') return null;
    }

    const body = Span{ .start = root_open + 1, .end = matchBrace(source, root_open) orelse return null };
    const indent = detectEntryIndent(source, body);
    const has_entries = firstNonSpace(source[body.start..body.end]) != null;

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, source[0..body.start]);
    try out.append(allocator, '\n');
    try out.appendSlice(allocator, indent);
    try out.append(allocator, '"');
    try out.appendSlice(allocator, section);
    try out.appendSlice(allocator, "\": {\n");
    try out.appendSlice(allocator, indent);
    try out.appendSlice(allocator, indent);
    try out.append(allocator, '"');
    try out.appendSlice(allocator, name);
    try out.appendSlice(allocator, "\": \"");
    try out.appendSlice(allocator, version);
    try out.appendSlice(allocator, "\"\n");
    try out.appendSlice(allocator, indent);
    try out.append(allocator, '}');
    if (has_entries) try out.append(allocator, ',');
    try out.appendSlice(allocator, source[body.start..]);
    return try out.toOwnedSlice(allocator);
}

const Span = struct { start: usize, end: usize };
const KeyValueSpan = struct { value_start: usize, value_end: usize };

/// Byte range between the braces of `"<section>": { … }`, or null.
fn findSectionBody(source: []const u8, section: []const u8) ?Span {
    var search: usize = 0;
    while (true) {
        const key_at = indexOfKey(source, search, section) orelse return null;
        var i = key_at;
        // Skip the key, then whitespace, then the colon.
        i += section.len + 2;
        i = skipSpace(source, i);
        if (i >= source.len or source[i] != ':') {
            search = key_at + 1;
            continue;
        }
        i = skipSpace(source, i + 1);
        if (i >= source.len or source[i] != '{') {
            search = key_at + 1;
            continue;
        }
        const body_start = i + 1;
        const body_end = matchBrace(source, i) orelse return null;
        return .{ .start = body_start, .end = body_end };
    }
}

/// Position of `"<key>"` at the top level of `body`, with its value span.
fn findKeyValueSpan(source: []const u8, body: Span, key: []const u8) ?KeyValueSpan {
    var i = body.start;
    var depth: usize = 0;

    while (i < body.end) {
        const c = source[i];
        if (c == '"') {
            const str_end = endOfString(source, i) orelse return null;
            if (depth == 0 and std.mem.eql(u8, source[i + 1 .. str_end], key)) {
                var j = skipSpace(source, str_end + 1);
                if (j < body.end and source[j] == ':') {
                    j = skipSpace(source, j + 1);
                    if (j < body.end and source[j] == '"') {
                        const val_end = endOfString(source, j) orelse return null;
                        return .{ .value_start = j, .value_end = val_end + 1 };
                    }
                }
            }
            i = str_end + 1;
            continue;
        }
        if (c == '{' or c == '[') depth += 1;
        if (c == '}' or c == ']') {
            if (depth == 0) break;
            depth -= 1;
        }
        i += 1;
    }
    return null;
}

/// Indentation of the first entry in the section, so an inserted line lines up.
/// Falls back to four spaces for an empty section.
fn detectEntryIndent(source: []const u8, body: Span) []const u8 {
    var i = body.start;
    while (i < body.end and (source[i] == '\n' or source[i] == '\r')) i += 1;
    const line_start = i;
    while (i < body.end and (source[i] == ' ' or source[i] == '\t')) i += 1;
    if (i > line_start and i < body.end) return source[line_start..i];
    return "    ";
}

/// Index of `"<key>"` at or after `from`, ignoring occurrences inside strings
/// only insofar as the quote pairing allows — good enough because a key is
/// always quote-delimited and immediately followed by a colon, which the
/// caller verifies.
fn indexOfKey(source: []const u8, from: usize, key: []const u8) ?usize {
    if (from >= source.len) return null;
    var buf: [256]u8 = undefined;
    if (key.len + 2 > buf.len) return null;
    buf[0] = '"';
    @memcpy(buf[1 .. key.len + 1], key);
    buf[key.len + 1] = '"';
    const needle = buf[0 .. key.len + 2];
    const at = std.mem.indexOfPos(u8, source, from, needle) orelse return null;
    return at;
}

fn skipSpace(source: []const u8, from: usize) usize {
    var i = from;
    while (i < source.len and (source[i] == ' ' or source[i] == '\t' or source[i] == '\n' or source[i] == '\r')) i += 1;
    return i;
}

fn firstNonSpace(slice: []const u8) ?usize {
    for (slice, 0..) |c, i| {
        if (c != ' ' and c != '\t' and c != '\n' and c != '\r' and c != ',') return i;
    }
    return null;
}

/// Index of the closing quote of the string starting at `open`.
fn endOfString(source: []const u8, open: usize) ?usize {
    var i = open + 1;
    while (i < source.len) {
        if (source[i] == '\\') {
            i += 2;
            continue;
        }
        if (source[i] == '"') return i;
        i += 1;
    }
    return null;
}

/// Index of the `}` matching the `{` at `open`, skipping strings.
fn matchBrace(source: []const u8, open: usize) ?usize {
    var depth: usize = 0;
    var i = open;
    while (i < source.len) {
        const c = source[i];
        if (c == '"') {
            i = (endOfString(source, i) orelse return null) + 1;
            continue;
        }
        if (c == '{') depth += 1;
        if (c == '}') {
            depth -= 1;
            if (depth == 0) return i;
        }
        i += 1;
    }
    return null;
}

// ── setDependency ───────────────────────────────────────────────────────────

test "setDependency replaces an existing version and keeps every comment" {
    const src =
        \\{
        \\  // the toolchain
        \\  "dependencies": {
        \\    "ziglang.org": "0.16.0-dev", // pinned
        \\    "zig-cli": "github:zig-utils/zig-cli"
        \\  },
        \\  "scripts": {
        \\    // Build & Run
        \\    "build": "zig build"
        \\  }
        \\}
    ;
    const out = (try setDependency(std.testing.allocator, src, "dependencies", "ziglang.org", "^0.16.0")).?;
    defer std.testing.allocator.free(out);

    try std.testing.expect(std.mem.indexOf(u8, out, "\"ziglang.org\": \"^0.16.0\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "0.16.0-dev") == null);
    // The comments are the whole point.
    try std.testing.expect(std.mem.indexOf(u8, out, "// the toolchain") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "// pinned") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "// Build & Run") != null);
    // And so is leaving everything else alone.
    try std.testing.expect(std.mem.indexOf(u8, out, "\"zig-cli\": \"github:zig-utils/zig-cli\"") != null);
}

test "setDependency inserts a missing dependency" {
    const src =
        \\{
        \\  "dependencies": {
        \\    "zig-cli": "1.0.0"
        \\  }
        \\}
    ;
    const out = (try setDependency(std.testing.allocator, src, "dependencies", "ziglang.org", "^0.16.0")).?;
    defer std.testing.allocator.free(out);

    try std.testing.expect(std.mem.indexOf(u8, out, "\"ziglang.org\": \"^0.16.0\",") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "\"zig-cli\": \"1.0.0\"") != null);
}

test "setDependency inserts into an empty section without a stray comma" {
    const src =
        \\{
        \\  "dependencies": {}
        \\}
    ;
    const out = (try setDependency(std.testing.allocator, src, "dependencies", "a.org", "1.0.0")).?;
    defer std.testing.allocator.free(out);

    try std.testing.expect(std.mem.indexOf(u8, out, "\"a.org\": \"1.0.0\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "1.0.0\",") == null);
}

test "setDependency targets the named section only" {
    const src =
        \\{
        \\  "dependencies": { "shared": "1.0.0" },
        \\  "devDependencies": { "shared": "2.0.0" }
        \\}
    ;
    const out = (try setDependency(std.testing.allocator, src, "devDependencies", "shared", "3.0.0")).?;
    defer std.testing.allocator.free(out);

    try std.testing.expect(std.mem.indexOf(u8, out, "\"dependencies\": { \"shared\": \"1.0.0\" }") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "\"shared\": \"3.0.0\"") != null);
}

test "setDependency does not match a key nested deeper in the section" {
    // `overrides.ziglang.org` must not be mistaken for the dependency itself.
    const src =
        \\{
        \\  "dependencies": {
        \\    "overrides": { "ziglang.org": "0.1.0" },
        \\    "ziglang.org": "0.15.0"
        \\  }
        \\}
    ;
    const out = (try setDependency(std.testing.allocator, src, "dependencies", "ziglang.org", "^0.16.0")).?;
    defer std.testing.allocator.free(out);

    try std.testing.expect(std.mem.indexOf(u8, out, "\"overrides\": { \"ziglang.org\": \"0.1.0\" }") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "\"ziglang.org\": \"^0.16.0\"") != null);
}

test "setDependency creates a missing section rather than falling back" {
    // The fallback path wrote the package at the ROOT of the document, and
    // dropped every comment on the way.
    const src =
        \\{
        \\  // project
        \\  "name": "x"
        \\}
    ;
    const out = (try setDependency(std.testing.allocator, src, "devDependencies", "bun.sh", "^1.3.0")).?;
    defer std.testing.allocator.free(out);

    try std.testing.expect(std.mem.indexOf(u8, out, "\"devDependencies\": {") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "\"bun.sh\": \"^1.3.0\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "// project") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "\"name\": \"x\"") != null);

    // And the result still parses.
    const stripped = try stripComments(std.testing.allocator, out);
    defer std.testing.allocator.free(stripped);
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, stripped, .{});
    defer parsed.deinit();
    try std.testing.expect(parsed.value.object.get("devDependencies") != null);
}

test "setDependency gives up when the section is not an object" {
    const src =
        \\{
        \\  "dependencies": ["a"]
        \\}
    ;
    try std.testing.expect(try setDependency(std.testing.allocator, src, "dependencies", "a", "1") == null);
}

test "setDependency preserves a scoped package name" {
    const src =
        \\{
        \\  "dependencies": {
        \\    "@scope/pkg": "1.0.0"
        \\  }
        \\}
    ;
    const out = (try setDependency(std.testing.allocator, src, "dependencies", "@scope/pkg", "2.0.0")).?;
    defer std.testing.allocator.free(out);

    try std.testing.expect(std.mem.indexOf(u8, out, "\"@scope/pkg\": \"2.0.0\"") != null);
}
