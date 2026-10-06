//! Repair the links a project's pantry tree already holds.
//!
//! Since 0.11.70, links pantry writes inside a tree are relative (see
//! `symlink.treeLinkTarget`). Trees installed before that still hold absolute
//! links, and some point somewhere that no longer exists:
//!
//!   - links written through a git worktree that shared the tree, aimed at
//!     `<worktree>/pantry/...`, which dangle once the worktree is deleted -
//!     the case that broke git, bun and every dylib reached through
//!     `zlib.net/v1` in a stacks checkout;
//!   - `.bin` entries for files a package no longer ships, such as the bundle
//!     chunks an older pantry linked out of an npm package's `dist/bin`, left
//!     dangling by every upgrade that renamed them.
//!
//! `pantry install` skips packages already on disk, so none of these were
//! ever rewritten. This sweep runs after each project install: an absolute
//! link into the tree is made relative; a dangling link whose path names a
//! file this tree has is pointed at it; anything else dangling in `.bin` or
//! among the version aliases is removed. Links that point outside the tree on
//! purpose (a workspace package linked from the project) are left alone.

const std = @import("std");
const builtin = @import("builtin");
const io_helper = @import("../io_helper.zig");
const symlink = @import("symlink.zig");

pub const Stats = struct {
    /// Absolute links into the tree rewritten as relative ones.
    relinked: usize = 0,
    /// Dangling links pointed at the same file in this tree.
    retargeted: usize = 0,
    /// Dangling links removed.
    removed: usize = 0,
};

/// Repair `.bin` and the version aliases under `tree_root` (a project's
/// `pantry/`). Never fails: a link it cannot repair is left as it was.
pub fn repairTree(allocator: std.mem.Allocator, tree_root: []const u8) Stats {
    var stats: Stats = .{};
    if (builtin.os.tag == .windows) return stats;

    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const bin_dir = std.fmt.allocPrint(arena, "{s}/.bin", .{tree_root}) catch return stats;
    repairDir(arena, tree_root, bin_dir, .bin, &stats);

    // Version aliases sit beside the versions they name, one to three levels
    // down: `zlib.net/v1`, `gnu.org/gettext/v1`.
    walkAliases(arena, tree_root, tree_root, 0, &stats);
    return stats;
}

const DirKind = enum { bin, aliases };

fn walkAliases(arena: std.mem.Allocator, tree_root: []const u8, dir_path: []const u8, depth: u8, stats: *Stats) void {
    if (depth >= 3) return;
    var dir = io_helper.openDirForIteration(dir_path) catch return;
    defer dir.close();

    var subdirs = std.ArrayList([]const u8).initCapacity(arena, 8) catch return;
    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (entry.kind != .directory) continue;
        // `.bin` is repaired on its own; installed versions and npm packages
        // hold no aliases to find, and walking them would read the whole tree.
        if (entry.name[0] == '.' or isVersionName(entry.name) or std.mem.eql(u8, entry.name, "node_modules")) continue;
        const sub = std.fmt.allocPrint(arena, "{s}/{s}", .{ dir_path, entry.name }) catch continue;
        subdirs.append(arena, sub) catch continue;
    }

    if (depth > 0) repairDir(arena, tree_root, dir_path, .aliases, stats);
    for (subdirs.items) |sub| walkAliases(arena, tree_root, sub, depth + 1, stats);
}

/// `v1`, `v1.3`, `v1.3.2`: a version directory or an alias for one.
fn isVersionName(name: []const u8) bool {
    return name.len >= 2 and name[0] == 'v' and std.ascii.isDigit(name[1]);
}

fn repairDir(arena: std.mem.Allocator, tree_root: []const u8, dir_path: []const u8, kind: DirKind, stats: *Stats) void {
    var dir = io_helper.openDirForIteration(dir_path) catch return;
    defer dir.close();

    var entries = std.ArrayList(struct { name: []const u8, is_link: bool }).initCapacity(arena, 16) catch return;
    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        const is_link = entry.kind == .sym_link;
        if (kind == .aliases and !(is_link and isVersionName(entry.name))) continue;
        if (kind == .bin and !is_link and entry.kind != .file) continue;
        const name = arena.dupe(u8, entry.name) catch continue;
        entries.append(arena, .{ .name = name, .is_link = is_link }) catch continue;
    }

    for (entries.items) |entry| {
        const path = std.fmt.allocPrint(arena, "{s}/{s}", .{ dir_path, entry.name }) catch continue;
        if (entry.is_link)
            repairLink(arena, tree_root, path, stats)
        else
            repairShim(arena, tree_root, path, stats);
    }
}

fn exists(path: []const u8) bool {
    io_helper.access(path, .{}) catch return false;
    return true;
}

/// The same file in this tree for a path written through another tree:
/// `<elsewhere>/pantry/zlib.net/v1.3.2` -> `<tree_root>/zlib.net/v1.3.2`,
/// when that exists. Null otherwise.
fn sameFileHere(arena: std.mem.Allocator, tree_root: []const u8, target: []const u8) ?[]const u8 {
    const base = std.fs.path.basename(tree_root);
    const marker = std.fmt.allocPrint(arena, "/{s}/", .{base}) catch return null;
    const at = std.mem.lastIndexOf(u8, target, marker) orelse return null;
    const rest = target[at + marker.len ..];
    if (rest.len == 0) return null;
    const candidate = std.fmt.allocPrint(arena, "{s}/{s}", .{ tree_root, rest }) catch return null;
    return if (exists(candidate)) candidate else null;
}

fn repairLink(arena: std.mem.Allocator, tree_root: []const u8, link_path: []const u8, stats: *Stats) void {
    const raw = io_helper.readLinkAlloc(arena, link_path) catch return;
    if (!std.fs.path.isAbsolute(raw)) {
        if (!exists(link_path)) {
            io_helper.deleteFile(link_path) catch return;
            stats.removed += 1;
        }
        return;
    }

    if (exists(raw)) {
        // Points somewhere real. Relative only when that is inside the tree.
        const target = symlink.treeLinkTarget(arena, tree_root, raw, link_path) catch return;
        if (std.fs.path.isAbsolute(target)) return;
        replaceLink(target, link_path) catch return;
        stats.relinked += 1;
        return;
    }

    if (sameFileHere(arena, tree_root, raw)) |here| {
        const target = symlink.treeLinkTarget(arena, tree_root, here, link_path) catch return;
        replaceLink(target, link_path) catch return;
        stats.retargeted += 1;
        return;
    }

    io_helper.deleteFile(link_path) catch return;
    stats.removed += 1;
}

fn replaceLink(target: []const u8, link_path: []const u8) !void {
    io_helper.deleteFile(link_path) catch {};
    try io_helper.symLink(target, link_path);
}

/// The forwarding shims an older pantry wrote: `#!/bin/sh` then
/// `exec <prefix>"<absolute target>" "$@"`. Anything else is not ours.
fn repairShim(arena: std.mem.Allocator, tree_root: []const u8, shim_path: []const u8, stats: *Stats) void {
    const content = io_helper.readFileAlloc(arena, shim_path, 4096) catch return;
    const head = "#!/bin/sh\nexec ";
    if (!std.mem.startsWith(u8, content, head)) return;
    const rest = content[head.len..];
    const open = std.mem.indexOfScalar(u8, rest, '"') orelse return;
    const prefix = rest[0..open];
    const after = rest[open + 1 ..];
    const close = std.mem.indexOfScalar(u8, after, '"') orelse return;
    const target = after[0..close];
    if (!std.mem.eql(u8, after[close..], "\" \"$@\"\n")) return;
    if (!std.fs.path.isAbsolute(target)) return;

    const live = if (exists(target)) target else sameFileHere(arena, tree_root, target);
    if (live) |here| {
        const rel = symlink.treeLinkTarget(arena, tree_root, here, shim_path) catch return;
        if (std.fs.path.isAbsolute(rel) and std.mem.eql(u8, here, target)) return; // outside the tree, and fine
        if (!symlink.writeShim(arena, shim_path, prefix, here, tree_root)) return;
        if (std.mem.eql(u8, here, target)) stats.relinked += 1 else stats.retargeted += 1;
        return;
    }

    io_helper.deleteFile(shim_path) catch return;
    stats.removed += 1;
}

test "repairTree makes tree links relative, retargets links into another tree's copy, and drops the dangling" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    const allocator = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var tmp_dir = std.testing.tmpDir(.{});
    defer tmp_dir.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp_dir.dir.realPath(io_helper.io, &root_buf)];
    const tree = try std.fmt.allocPrint(arena, "{s}/main/pantry", .{root});

    const files = [_][]const u8{
        "zlib.net/v1.3.2/lib/libz.dylib",
        "bun.com/v1.4.2/bin/bun",
        "git-scm.org/v2.53.0/bin/git",
        "@stacksjs/ts-cloud/dist/bin/cli.js",
    };
    for (files) |sub| {
        const path = try std.fmt.allocPrint(arena, "{s}/{s}", .{ tree, sub });
        try io_helper.makePath(std.fs.path.dirname(path).?);
        const file = try io_helper.createFile(path, .{});
        io_helper.closeFile(file);
    }
    try io_helper.makePath(try std.fmt.allocPrint(arena, "{s}/.bin", .{tree}));

    const at = struct {
        fn p(a: std.mem.Allocator, base: []const u8, sub: []const u8) []const u8 {
            return std.fmt.allocPrint(a, "{s}/{s}", .{ base, sub }) catch @panic("oom");
        }
    }.p;
    const gone = "/nowhere/stacks-wt-gone/pantry";

    // An absolute alias into this tree; one written through a deleted worktree.
    try io_helper.symLink(at(arena, tree, "zlib.net/v1.3.2"), at(arena, tree, "zlib.net/v1"));
    try io_helper.symLink(at(arena, gone, "zlib.net/v1.3.2"), at(arena, tree, "zlib.net/v1.3"));
    // .bin: absolute into the tree, through the deleted worktree, a chunk
    // nothing ships any more, and a shim written through the worktree.
    try io_helper.symLink(at(arena, tree, "bun.com/v1.4.2/bin/bun"), at(arena, tree, ".bin/bun"));
    try io_helper.symLink(at(arena, gone, "@stacksjs/ts-cloud/dist/bin/cli.js"), at(arena, tree, ".bin/cloud"));
    try io_helper.symLink(at(arena, tree, "@stacksjs/ts-cloud/dist/bin/chunk-old.js"), at(arena, tree, ".bin/chunk-old.js"));
    {
        const shim = try io_helper.createFile(at(arena, tree, ".bin/git"), .{});
        try io_helper.writeAllToFile(shim, try std.fmt.allocPrint(arena, "#!/bin/sh\nexec \"{s}/git-scm.org/v2.53.0/bin/git\" \"$@\"\n", .{gone}));
        io_helper.closeFile(shim);
    }
    // A link out of the tree on purpose stays as it is.
    try io_helper.symLink(root, at(arena, tree, ".bin/workspace"));

    const stats = repairTree(allocator, tree);

    try std.testing.expectEqualStrings("v1.3.2", try io_helper.readLinkAlloc(arena, at(arena, tree, "zlib.net/v1")));
    try std.testing.expectEqualStrings("v1.3.2", try io_helper.readLinkAlloc(arena, at(arena, tree, "zlib.net/v1.3")));
    try std.testing.expectEqualStrings("../bun.com/v1.4.2/bin/bun", try io_helper.readLinkAlloc(arena, at(arena, tree, ".bin/bun")));
    try std.testing.expectEqualStrings("../@stacksjs/ts-cloud/dist/bin/cli.js", try io_helper.readLinkAlloc(arena, at(arena, tree, ".bin/cloud")));
    try std.testing.expect(!exists(at(arena, tree, ".bin/chunk-old.js")));
    try std.testing.expectEqualStrings(root, try io_helper.readLinkAlloc(arena, at(arena, tree, ".bin/workspace")));

    const shim = try io_helper.readFileAlloc(arena, at(arena, tree, ".bin/git"), 4096);
    try std.testing.expect(std.mem.indexOf(u8, shim, gone) == null);
    try std.testing.expect(std.mem.indexOf(u8, shim, "\"$d/../git-scm.org/v2.53.0/bin/git\"") != null);

    try std.testing.expectEqual(@as(usize, 2), stats.relinked);
    try std.testing.expectEqual(@as(usize, 3), stats.retargeted);
    try std.testing.expectEqual(@as(usize, 1), stats.removed);

    // Idempotent: a repaired tree has nothing left to repair.
    const again = repairTree(allocator, tree);
    try std.testing.expectEqual(@as(usize, 0), again.relinked + again.retargeted + again.removed);
}
