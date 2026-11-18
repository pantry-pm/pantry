const std = @import("std");
const io_helper = @import("../io_helper.zig");

/// Sync build.zig.zon dependencies block to match installed Zig packages in the pantry/ directory.
///
/// After `pantry install`, this function:
/// 1. Finds the project's build.zig.zon (if it exists)
/// 2. Scans the pantry/ directory for Zig library packages (those containing a build.zig.zon)
/// 3. Adds or updates a local .path entry for each of them
/// 4. Removes entries that point into pantry/ for packages that are no longer installed
///
/// Only entries whose value is a `.path` into the pantry directory belong to this sync. Every
/// other entry (registry tarballs with `.url` and `.hash`, paths elsewhere, lazy dependencies) is
/// the project's own declaration and is kept byte for byte, and a declared dependency is never
/// replaced by a pantry path of the same name. This used to replace the whole block, so a bare
/// `pantry install` deleted every registry dependency a project declared.
///
/// If no build.zig.zon exists in the project, this is a no-op.
pub fn syncBuildZigZon(allocator: std.mem.Allocator, project_dir: []const u8, pantry_dir_name: []const u8, verbose: bool) !void {
    // Check if build.zig.zon exists in the project root
    const zon_path = try std.fs.path.join(allocator, &.{ project_dir, "build.zig.zon" });
    defer allocator.free(zon_path);

    const zon_content = io_helper.readFileAlloc(allocator, zon_path, 1024 * 1024) catch |err| {
        if (err == error.FileNotFound) return; // No build.zig.zon, nothing to sync
        return err;
    };
    defer allocator.free(zon_content);

    // Scan pantry/ dir for zig packages (directories that contain a build.zig.zon)
    const pantry_path = try std.fs.path.join(allocator, &.{ project_dir, pantry_dir_name });
    defer allocator.free(pantry_path);

    var zig_deps = std.ArrayList(ZigDep).empty;
    defer {
        for (zig_deps.items) |dep| {
            allocator.free(dep.name);
            allocator.free(dep.rel_path);
        }
        zig_deps.deinit(allocator);
    }

    var pantry_dir = io_helper.openDirForIteration(pantry_path) catch |err| {
        if (err == error.FileNotFound) return;
        return err;
    };
    defer pantry_dir.close();

    var dir_it = pantry_dir.iterate();
    while (try dir_it.next()) |entry| {
        if (entry.kind != .directory) continue;

        // Check if this directory contains a build.zig.zon (indicating it's a zig package)
        const sub_zon = try std.fmt.allocPrint(allocator, "{s}/{s}/build.zig.zon", .{ pantry_path, entry.name });
        defer allocator.free(sub_zon);

        const has_zon = blk: {
            io_helper.accessAbsolute(sub_zon, .{}) catch break :blk false;
            break :blk true;
        };

        if (has_zon) {
            // Convert hyphenated name to underscore for zig identifier
            const zig_name = try hyphenToUnderscore(allocator, entry.name);
            const rel_path = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ pantry_dir_name, entry.name });

            try zig_deps.append(allocator, .{
                .name = zig_name,
                .rel_path = rel_path,
            });
        }
    }

    if (zig_deps.items.len == 0 and findDependenciesStart(zon_content) == null) {
        return; // No zig deps and no existing deps block, nothing to do
    }

    // Generate the new build.zig.zon content
    const new_content = try generateUpdatedZon(allocator, zon_content, zig_deps.items, pantry_dir_name);
    defer allocator.free(new_content);

    // Only write if content changed
    if (std.mem.eql(u8, zon_content, new_content)) {
        if (verbose) {
            std.debug.print("build.zig.zon: already up to date\n", .{});
        }
        return;
    }

    // Write the updated content
    const file = try io_helper.createFile(zon_path, .{});
    defer file.close(io_helper.io);
    try io_helper.writeAllToFile(file, new_content);

    if (verbose) {
        std.debug.print("build.zig.zon: synced {d} zig dependencies\n", .{zig_deps.items.len});
    }
}

const ZigDep = struct {
    name: []const u8, // zig identifier (underscores)
    rel_path: []const u8, // relative path from project root
};

/// Convert hyphens to underscores for a valid Zig bare identifier
fn hyphenToUnderscore(allocator: std.mem.Allocator, name: []const u8) ![]const u8 {
    const result = try allocator.alloc(u8, name.len);
    for (name, 0..) |c, i| {
        result[i] = if (c == '-') '_' else c;
    }
    return result;
}

/// Offset of the `.dependencies` field, skipping comments and strings that mention it.
fn findDependenciesStart(content: []const u8) ?usize {
    var i: usize = 0;
    while (i < content.len) {
        const c = content[i];
        if (c == '/' and i + 1 < content.len and content[i + 1] == '/') {
            while (i < content.len and content[i] != '\n') i += 1;
            continue;
        }
        if (c == '"') {
            i = skipString(content, i);
            continue;
        }
        if (c == '.' and std.mem.startsWith(u8, content[i..], ".dependencies")) {
            const after = i + ".dependencies".len;
            if (after >= content.len or !isIdentChar(content[after])) return i;
        }
        i += 1;
    }
    return null;
}

fn isIdentChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_';
}

/// Index just past the string literal starting at `start` (which must be a `"`).
fn skipString(content: []const u8, start: usize) usize {
    var i = start + 1;
    while (i < content.len) : (i += 1) {
        if (content[i] == '\\') {
            i += 1;
        } else if (content[i] == '"' or content[i] == '\n') {
            return i + 1;
        }
    }
    return content.len;
}

/// Index just past the `}` that closes the `{` at `open`, honouring strings and comments.
fn matchBrace(content: []const u8, open: usize) ?usize {
    var depth: usize = 0;
    var i = open;
    while (i < content.len) {
        const c = content[i];
        if (c == '/' and i + 1 < content.len and content[i + 1] == '/') {
            while (i < content.len and content[i] != '\n') i += 1;
            continue;
        }
        if (c == '"') {
            i = skipString(content, i);
            continue;
        }
        if (c == '{') depth += 1;
        if (c == '}') {
            depth -= 1;
            if (depth == 0) return i + 1;
        }
        i += 1;
    }
    return null;
}

/// One `.name = .{ ... },` entry of the dependencies block, kept as written.
const Entry = struct {
    name: []const u8,
    text: []const u8,
    /// Its value is a `.path` into the pantry directory, so this sync owns it.
    owned: bool,
};

/// Split the inside of a `.dependencies = .{ ... }` block into entries. Text between entries
/// (comments, blank lines) is attached to the entry that follows it, so it survives a rewrite.
fn parseEntries(allocator: std.mem.Allocator, inner: []const u8, pantry_dir_name: []const u8) !std.ArrayList(Entry) {
    var entries = std.ArrayList(Entry).empty;
    errdefer entries.deinit(allocator);
    var segment_start: usize = 0;
    var i: usize = 0;
    while (i < inner.len) {
        const c = inner[i];
        if (c == '/' and i + 1 < inner.len and inner[i + 1] == '/') {
            while (i < inner.len and inner[i] != '\n') i += 1;
            continue;
        }
        if (c != '.') {
            i += 1;
            continue;
        }
        // `.name` or `.@"name"`
        var name_start = i + 1;
        var name_end = name_start;
        if (name_start + 1 < inner.len and inner[name_start] == '@' and inner[name_start + 1] == '"') {
            name_start += 2;
            name_end = name_start;
            while (name_end < inner.len and inner[name_end] != '"') name_end += 1;
        } else {
            while (name_end < inner.len and isIdentChar(inner[name_end])) name_end += 1;
        }
        const open = std.mem.indexOfScalarPos(u8, inner, name_end, '{') orelse break;
        const close = matchBrace(inner, open) orelse break;
        var end = close;
        while (end < inner.len and (inner[end] == ',' or inner[end] == ' ' or inner[end] == '\t' or inner[end] == '\r')) end += 1;
        if (end < inner.len and inner[end] == '\n') end += 1;

        const body = inner[open..close];
        try entries.append(allocator, .{
            .name = inner[name_start..name_end],
            .text = inner[segment_start..end],
            .owned = isPantryPath(body, pantry_dir_name),
        });
        segment_start = end;
        i = end;
    }
    return entries;
}

/// Whether an entry body is `.{ .path = "<pantry_dir>/..." }` and nothing that names a source.
fn isPantryPath(body: []const u8, pantry_dir_name: []const u8) bool {
    if (std.mem.indexOf(u8, body, ".url") != null) return false;
    const key = std.mem.indexOf(u8, body, ".path") orelse return false;
    const quote = std.mem.indexOfScalarPos(u8, body, key, '"') orelse return false;
    const value = body[quote + 1 ..];
    return std.mem.startsWith(u8, value, pantry_dir_name) and value.len > pantry_dir_name.len and value[pantry_dir_name.len] == '/';
}

fn appendPathEntry(allocator: std.mem.Allocator, buf: *std.ArrayList(u8), dep: ZigDep) !void {
    try buf.appendSlice(allocator, "        .");
    try buf.appendSlice(allocator, dep.name);
    try buf.appendSlice(allocator, " = .{\n            .path = \"");
    try buf.appendSlice(allocator, dep.rel_path);
    try buf.appendSlice(allocator, "\",\n        },\n");
}

/// Generate updated build.zig.zon content with synced dependencies.
/// Preserves everything outside the .dependencies block, and every entry this sync does not own.
fn generateUpdatedZon(allocator: std.mem.Allocator, original: []const u8, deps: []const ZigDep, pantry_dir_name: []const u8) ![]const u8 {
    var buf = std.ArrayList(u8).empty;
    errdefer buf.deinit(allocator);

    if (findDependenciesStart(original)) |dep_start| {
        const open = std.mem.indexOfScalarPos(u8, original, dep_start, '{') orelse return allocator.dupe(u8, original);
        const close = matchBrace(original, open) orelse return allocator.dupe(u8, original);
        const inner = original[open + 1 .. close - 1];

        var entries = try parseEntries(allocator, inner, pantry_dir_name);
        defer entries.deinit(allocator);

        try buf.appendSlice(allocator, original[0 .. open + 1]);
        var body = std.ArrayList(u8).empty;
        defer body.deinit(allocator);
        for (entries.items) |entry| {
            // Owned entries are re-emitted below for packages that are still installed.
            if (!entry.owned) try body.appendSlice(allocator, entry.text);
        }
        for (deps) |dep| {
            var declared = false;
            for (entries.items) |entry| {
                if (!entry.owned and std.mem.eql(u8, entry.name, dep.name)) declared = true;
            }
            if (!declared) try appendPathEntry(allocator, &body, dep);
        }
        if (body.items.len == 0) {
            try buf.appendSlice(allocator, "}");
        } else {
            if (body.items[0] != '\n') try buf.append(allocator, '\n');
            try buf.appendSlice(allocator, body.items);
            if (body.items[body.items.len - 1] != '\n') try buf.append(allocator, '\n');
            try buf.appendSlice(allocator, "    }");
        }
        try buf.appendSlice(allocator, original[close..]);
        return try buf.toOwnedSlice(allocator);
    }

    if (deps.len == 0) return allocator.dupe(u8, original);

    var deps_block = std.ArrayList(u8).empty;
    defer deps_block.deinit(allocator);
    try deps_block.appendSlice(allocator, "    .dependencies = .{\n");
    for (deps) |dep| try appendPathEntry(allocator, &deps_block, dep);
    try deps_block.appendSlice(allocator, "    },\n");

    // No existing .dependencies block: insert before .paths, or before the closing brace.
    if (std.mem.indexOf(u8, original, ".paths")) |paths_start| {
        var line_start = paths_start;
        while (line_start > 0 and original[line_start - 1] != '\n') line_start -= 1;
        try buf.appendSlice(allocator, original[0..line_start]);
        try buf.appendSlice(allocator, deps_block.items);
        try buf.appendSlice(allocator, original[line_start..]);
    } else {
        const last_brace = std.mem.lastIndexOf(u8, original, "}") orelse return allocator.dupe(u8, original);
        try buf.appendSlice(allocator, original[0..last_brace]);
        try buf.appendSlice(allocator, deps_block.items);
        try buf.appendSlice(allocator, original[last_brace..]);
    }
    return try buf.toOwnedSlice(allocator);
}

const registry_zon =
    \\.{
    \\    .name = .demo,
    \\    .version = "0.1.0",
    \\    // Registry tarballs; `.dependencies` in this comment must not confuse the sync.
    \\    .dependencies = .{
    \\        .bench = .{
    \\            .lazy = true,
    \\            .url = "https://registry.pantry.dev/zig/packages/zig-bench/0.2.1/tarball",
    \\            .hash = "zig_bench-0.2.1-abc",
    \\        },
    \\        .old_local = .{
    \\            .path = "pantry/old-local",
    \\        },
    \\        .vendored = .{ .path = "vendor/thing" },
    \\    },
    \\    .paths = .{ "build.zig", "src" },
    \\}
    \\
;

test "keeps registry and foreign entries, refreshes pantry paths" {
    const allocator = std.testing.allocator;
    const deps = [_]ZigDep{.{ .name = "zig_cli", .rel_path = "pantry/zig-cli" }};
    const out = try generateUpdatedZon(allocator, registry_zon, &deps, "pantry");
    defer allocator.free(out);
    try std.testing.expect(std.mem.indexOf(u8, out, ".url = \"https://registry.pantry.dev/zig/packages/zig-bench/0.2.1/tarball\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, ".lazy = true") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, ".vendored = .{ .path = \"vendor/thing\" }") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, ".zig_cli = .{\n            .path = \"pantry/zig-cli\"") != null);
    // pantry/old-local is no longer installed, so its owned entry goes.
    try std.testing.expect(std.mem.indexOf(u8, out, "old_local") == null);
    try std.testing.expect(std.mem.indexOf(u8, out, "// Registry tarballs") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, ".paths = .{ \"build.zig\", \"src\" }") != null);
}

test "a declared dependency is never replaced by a pantry path of the same name" {
    const allocator = std.testing.allocator;
    const deps = [_]ZigDep{.{ .name = "bench", .rel_path = "pantry/bench" }};
    const out = try generateUpdatedZon(allocator, registry_zon, &deps, "pantry");
    defer allocator.free(out);
    try std.testing.expect(std.mem.indexOf(u8, out, "pantry/bench") == null);
    try std.testing.expect(std.mem.indexOf(u8, out, "zig-bench/0.2.1/tarball") != null);
}

test "a project with only registry dependencies and nothing installed is unchanged" {
    const allocator = std.testing.allocator;
    const zon =
        \\.{
        \\    .name = .demo,
        \\    .dependencies = .{
        \\        .regex = .{
        \\            .url = "https://registry.pantry.dev/zig/packages/zig-regex/0.2.1/tarball",
        \\            .hash = "zig_regex-0.2.1-x",
        \\        },
        \\    },
        \\}
        \\
    ;
    const out = try generateUpdatedZon(allocator, zon, &.{}, "pantry");
    defer allocator.free(out);
    try std.testing.expectEqualStrings(zon, out);
}

test "adds a dependencies block when there is none" {
    const allocator = std.testing.allocator;
    const zon = ".{\n    .name = .demo,\n    .paths = .{\"src\"},\n}\n";
    const deps = [_]ZigDep{.{ .name = "zig_cli", .rel_path = "pantry/zig-cli" }};
    const out = try generateUpdatedZon(allocator, zon, &deps, "pantry");
    defer allocator.free(out);
    try std.testing.expect(std.mem.indexOf(u8, out, ".dependencies = .{\n        .zig_cli = .{\n            .path = \"pantry/zig-cli\",\n        },\n    },\n    .paths") != null);
}
