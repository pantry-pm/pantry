//! Make globally installed packages' shared libraries findable on Linux.
//!
//! Binaries built for the registry carry an RPATH of `$ORIGIN/../lib` only,
//! so a program finds its own libraries but not a dependency's: prime_server
//! installed with `pantry install -g` failed to start with `libzmq.so.5 =>
//! not found`, although zeromq.org was installed beside it. `pantry env` and
//! service units paper over that with LD_LIBRARY_PATH; a program started from
//! a shell or cron got nothing.
//!
//! A system-wide install (root, /usr/local) now does what the platform
//! expects: list every installed package's `lib/` in
//! /etc/ld.so.conf.d/pantry.conf and run `ldconfig`, so the dynamic loader
//! resolves them for every process. User-local installs cannot write there
//! and keep relying on the environment.

const std = @import("std");
const builtin = @import("builtin");
const io_helper = @import("../io_helper.zig");

/// Where the list goes. One file, rewritten whole on each global install.
pub const conf_path = "/etc/ld.so.conf.d/pantry.conf";

/// Domains nest (`github.com/valhalla/valhalla`), but not without limit.
const max_depth = 6;

/// A version directory: `v` then a digit (`v4.3.5`, `v0.13.1`).
fn isVersionDir(name: []const u8) bool {
    return name.len >= 2 and name[0] == 'v' and std.ascii.isDigit(name[1]);
}

fn hasLibDir(allocator: std.mem.Allocator, version_dir: []const u8) bool {
    const lib = std.fmt.allocPrint(allocator, "{s}/lib", .{version_dir}) catch return false;
    defer allocator.free(lib);
    var dir = io_helper.openDirForIteration(lib) catch return false;
    dir.close();
    return true;
}

fn walk(allocator: std.mem.Allocator, path: []const u8, depth: usize, out: *std.ArrayList([]const u8)) !void {
    if (depth > max_depth) return;
    var dir = io_helper.openDirForIteration(path) catch return;
    defer dir.close();

    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (entry.name.len == 0 or entry.name[0] == '.') continue;
        // Only real directories. The major-version shortcuts (`v4 -> v4.3.5`)
        // are symlinks; following them would list every version twice.
        if (entry.kind != .directory) continue;

        const child = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ path, entry.name });
        if (isVersionDir(entry.name)) {
            if (hasLibDir(allocator, child)) {
                const lib = try std.fmt.allocPrint(allocator, "{s}/lib", .{child});
                allocator.free(child);
                try out.append(allocator, lib);
            } else {
                allocator.free(child);
            }
            continue;
        }
        defer allocator.free(child);
        try walk(allocator, child, depth + 1, out);
    }
}

fn lessThan(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.lessThan(u8, a, b);
}

/// Every `<root>/<domain…>/v<version>/lib` directory, sorted. Caller frees
/// each entry and the list.
pub fn collectLibDirs(allocator: std.mem.Allocator, packages_root: []const u8) !std.ArrayList([]const u8) {
    var out = std.ArrayList([]const u8).empty;
    errdefer {
        for (out.items) |item| allocator.free(item);
        out.deinit(allocator);
    }
    try walk(allocator, packages_root, 0, &out);
    std.mem.sort([]const u8, out.items, {}, lessThan);
    return out;
}

/// The ld.so.conf.d file for these directories.
pub fn renderConf(allocator: std.mem.Allocator, lib_dirs: []const []const u8) ![]u8 {
    var buf = std.ArrayList(u8).empty;
    errdefer buf.deinit(allocator);
    try buf.appendSlice(allocator,
        \\# Written by `pantry install -g`: shared libraries of packages installed
        \\# under /usr/local/packages, so the dynamic loader finds them for every
        \\# process. Rewritten on each global install; edits will be lost.
        \\
    );
    for (lib_dirs) |dir| {
        try buf.appendSlice(allocator, dir);
        try buf.append(allocator, '\n');
    }
    return buf.toOwnedSlice(allocator);
}

pub const Registration = struct {
    /// Library directories now known to the loader.
    dirs: usize,
    /// Whether `ldconfig` ran and succeeded.
    ldconfig_ok: bool,
};

/// Write the conf file for everything under `packages_root` and refresh the
/// loader cache. Linux only; elsewhere a no-op returning null.
pub fn register(allocator: std.mem.Allocator, packages_root: []const u8) !?Registration {
    if (builtin.os.tag != .linux) return null;

    var dirs = try collectLibDirs(allocator, packages_root);
    defer {
        for (dirs.items) |item| allocator.free(item);
        dirs.deinit(allocator);
    }

    const content = try renderConf(allocator, dirs.items);
    defer allocator.free(content);

    const file = try io_helper.createFileAbsolute(conf_path, .{ .truncate = true });
    defer io_helper.closeFile(file);
    try io_helper.writeAllToFile(file, content);

    const ldconfig_ok = blk: {
        const result = io_helper.childRun(allocator, &.{"ldconfig"}) catch break :blk false;
        defer allocator.free(result.stdout);
        defer allocator.free(result.stderr);
        break :blk switch (result.term) {
            .exited => |code| code == 0,
            else => false,
        };
    };

    return .{ .dirs = dirs.items.len, .ldconfig_ok = ldconfig_ok };
}

test "isVersionDir: version directories only" {
    try std.testing.expect(isVersionDir("v4.3.5"));
    try std.testing.expect(isVersionDir("v0"));
    try std.testing.expect(!isVersionDir("v"));
    try std.testing.expect(!isVersionDir("valhalla"));
    try std.testing.expect(!isVersionDir("zeromq.org"));
}

test "renderConf: header then one directory per line" {
    const allocator = std.testing.allocator;
    const dirs = [_][]const u8{
        "/usr/local/packages/zeromq.org/v4.3.5/lib",
        "/usr/local/packages/zeromq.org/czmq/v4.2.1/lib",
    };
    const content = try renderConf(allocator, &dirs);
    defer allocator.free(content);
    try std.testing.expect(std.mem.startsWith(u8, content, "# Written by `pantry install -g`"));
    try std.testing.expect(std.mem.endsWith(u8, content, "/usr/local/packages/zeromq.org/v4.3.5/lib\n/usr/local/packages/zeromq.org/czmq/v4.2.1/lib\n"));
}

test "collectLibDirs: nested domains, real version dirs only, sorted" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    const allocator = std.testing.allocator;

    var rand: [8]u8 = undefined;
    io_helper.randomBytes(&rand);
    const root = try std.fmt.allocPrint(allocator, "{s}/pantry-shared-libs-{x}", .{ io_helper.getTempDir(), std.mem.readInt(u64, &rand, .little) });
    defer allocator.free(root);
    defer io_helper.deleteTree(root) catch {};

    const make = [_][]const u8{
        "zeromq.org/v4.3.5/lib",
        "zeromq.org/czmq/v4.2.1/lib",
        "github.com/valhalla/valhalla/v3.9.0/lib",
        "github.com/valhalla/valhalla/v3.9.0/bin",
        "python.org/v3.14.6/bin", // no lib: not listed
    };
    for (make) |rel| {
        const p = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ root, rel });
        defer allocator.free(p);
        try io_helper.makePath(p);
    }
    // The major-version shortcut is a symlink and must not be listed twice.
    const link = try std.fmt.allocPrint(allocator, "{s}/zeromq.org/v4", .{root});
    defer allocator.free(link);
    try io_helper.symLink("v4.3.5", link);

    var dirs = try collectLibDirs(allocator, root);
    defer {
        for (dirs.items) |item| allocator.free(item);
        dirs.deinit(allocator);
    }

    const expected = [_][]const u8{
        "github.com/valhalla/valhalla/v3.9.0/lib",
        "zeromq.org/czmq/v4.2.1/lib",
        "zeromq.org/v4.3.5/lib",
    };
    try std.testing.expectEqual(expected.len, dirs.items.len);
    for (expected, dirs.items) |rel, got| {
        const want = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ root, rel });
        defer allocator.free(want);
        try std.testing.expectEqualStrings(want, got);
    }
}
