const std = @import("std");
const io_helper = @import("../io_helper.zig");
const Paths = @import("../core/platform.zig").Paths;
const style = @import("../cli/style.zig");
const symlink = @import("symlink.zig");

pub const normalization_revision = "2\n";

/// Fix macOS library paths using install_name_tool
/// This discovers @rpath dependencies using otool and fixes them to use absolute paths
pub fn fixMacOSLibraryPaths(
    allocator: std.mem.Allocator,
    binary_path: []const u8,
    lib_dir: []const u8,
) !void {
    return fixMacOSLibraryPathsInTree(allocator, binary_path, lib_dir, null);
}

/// `fixMacOSLibraryPaths`, writing a reference to a library inside
/// `tree_root` as `@loader_path/<relative path>` rather than the absolute path
/// the tree was installed through. An absolute reference breaks the moment
/// that path does: a project installed through a git worktree's symlinked
/// `pantry` left curl loading libcurl from the worktree, so deleting the
/// worktree broke curl in the main checkout.
pub fn fixMacOSLibraryPathsInTree(
    allocator: std.mem.Allocator,
    binary_path: []const u8,
    lib_dir: []const u8,
    tree_root: ?[]const u8,
) !void {
    const builtin = @import("builtin");

    // Only run on macOS
    if (builtin.os.tag != .macos) {
        return;
    }

    // Use otool to get current library dependencies
    const otool_result = io_helper.childRun(allocator, &[_][]const u8{
        "otool",
        "-L",
        binary_path,
    }) catch {
        // Not a Mach-O binary or otool failed - just return
        return;
    };
    defer allocator.free(otool_result.stdout);
    defer allocator.free(otool_result.stderr);

    if (otool_result.term.exited != 0) {
        // Not a Mach-O binary or otool failed
        return;
    }

    // Collect dependencies that need fixing: both @rpath/ and hardcoded absolute paths
    const DepToFix = struct {
        original_ref: []const u8, // The original path as shown in otool output
        lib_name: []const u8, // Just the library filename
    };

    var deps_to_fix = try std.ArrayList(DepToFix).initCapacity(allocator, 8);
    defer {
        for (deps_to_fix.items) |dep| {
            allocator.free(dep.original_ref);
            allocator.free(dep.lib_name);
        }
        deps_to_fix.deinit(allocator);
    }

    // Standard system library directories that should NOT be rewritten
    const system_prefixes = [_][]const u8{
        "/usr/lib/",
        "/System/Library/",
        "/Library/Apple/",
    };

    var lines = std.mem.tokenizeScalar(u8, otool_result.stdout, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (!std.mem.endsWith(u8, trimmed, ")")) continue; // otool lines end with "(compatibility ...)"
        if (std.mem.indexOf(u8, trimmed, ".dylib") == null) continue;

        // Extract the path (everything before the first " (")
        const path_end = std.mem.indexOf(u8, trimmed, " (") orelse continue;
        const dep_path = std.mem.trim(u8, trimmed[0..path_end], " \t");
        if (dep_path.len == 0) continue;

        // Extract just the library filename
        const lib_name = if (std.mem.lastIndexOfScalar(u8, dep_path, '/')) |last_slash|
            dep_path[last_slash + 1 ..]
        else
            dep_path;

        // Case 1: @rpath/ references
        if (std.mem.startsWith(u8, dep_path, "@rpath/")) {
            try deps_to_fix.append(allocator, .{
                .original_ref = try allocator.dupe(u8, dep_path),
                .lib_name = try allocator.dupe(u8, lib_name),
            });
            continue;
        }

        // Case 2: Hardcoded absolute paths to non-system locations
        if (dep_path[0] == '/') {
            var is_system = false;
            for (system_prefixes) |prefix| {
                if (std.mem.startsWith(u8, dep_path, prefix)) {
                    is_system = true;
                    break;
                }
            }
            if (!is_system) {
                try deps_to_fix.append(allocator, .{
                    .original_ref = try allocator.dupe(u8, dep_path),
                    .lib_name = try allocator.dupe(u8, lib_name),
                });
            }
        }
    }

    // Fix each dependency
    for (deps_to_fix.items) |dep| {
        // Build absolute path using stack buffer: lib_dir/libfoo.dylib
        var abs_buf: [std.fs.max_path_bytes]u8 = undefined;
        const absolute_lib_path = std.fmt.bufPrint(&abs_buf, "{s}/{s}", .{ lib_dir, dep.lib_name }) catch continue;

        // Resolve the rewrite target. Prefer a copy in our own lib dir; if it's
        // not there (e.g. a binary built on a Homebrew box that hardcodes
        // /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib, which lives in a
        // SEPARATE pantry package), search the other installed packages for a
        // dylib of the same name. Without this, eza's bundled libssh2 keeps the
        // Homebrew path and dyld can't load it.
        var xpkg_buf: [std.fs.max_path_bytes]u8 = undefined;
        const target = blk: {
            if (io_helper.accessAbsolute(absolute_lib_path, .{})) |_| {
                break :blk @as([]const u8, absolute_lib_path);
            } else |_| {}
            // pkgx-layout artifacts name their dependencies by registry path,
            // `@rpath/sourceware.org/bzip2/v1.0.8/lib/libbz2.1.0.8.dylib`, which
            // resolves against the root the packages are installed under. A
            // project install (`<proj>/pantry/<domain>/v<ver>`) has no
            // `/packages/` segment for the search below to anchor on, so
            // xorriso's darwin build installed and then could not load libbz2.
            if (std.mem.startsWith(u8, dep.original_ref, "@rpath/")) {
                const rel = dep.original_ref["@rpath/".len..];
                if (findRpathRefInAncestors(lib_dir, rel, &xpkg_buf)) |p| break :blk p;
                // The reference pins the exact version the artifact was built
                // against, and the dependency's constraint is usually a range:
                // php.net 8.5.8 links `sourceware.org/libffi/v3.6.0/lib/
                // libffi.8.dylib`, declares `libffi>=3.4.7`, and gets 3.8.0, so
                // php could not start. The same soname under the same major is
                // the same ABI, and `v<major>` is the link pantry keeps to the
                // installed release of that major.
                var major_buf: [std.fs.max_path_bytes]u8 = undefined;
                if (majorVersionRef(rel, &major_buf)) |major_rel| {
                    if (findRpathRefInAncestors(lib_dir, major_rel, &xpkg_buf)) |p| break :blk p;
                }
            }
            if (findDylibInPackages(allocator, lib_dir, dep.lib_name, &xpkg_buf)) |p| break :blk p;
            // Nowhere to point it — leave the reference as-is.
            continue;
        };

        // An `@rpath/` reference stays one when the target is another installed
        // package: `@rpath/<domain>/v<major>/lib/<name>`, through the major link
        // pantry keeps, resolved by the artifact's own `@loader_path/../../..`
        // rpath. The `@loader_path/../../../harfbuzz.org/v14.6.0/...` it used
        // to become is longer than the reference it replaces, and a dylib
        // linked without header padding has no room for it: install_name_tool
        // refused, the error was ignored, and ffmpeg's libavfilter kept looking
        // for `harfbuzz.org/v8`, which the registry no longer has.
        var rpath_buf: [std.fs.max_path_bytes]u8 = undefined;
        var ref_buf: [std.fs.max_path_bytes]u8 = undefined;
        // A package's own libraries move with its binaries. A registry rpath
        // assumes a shared root that a mirrored artifact may not name: Java's
        // rpath reaches global/, while Pantry installs into global/packages/.
        // Keep those references local before considering cross-package rpaths.
        const own_root = std.fs.path.dirname(lib_dir) orelse lib_dir;
        const own_ref = loaderRelativeRef(allocator, own_root, target, binary_path, &ref_buf);
        const rpath_ref: ?[]const u8 = if (own_ref == null and std.mem.startsWith(u8, dep.original_ref, "@rpath/")) packagesRpathRef(target, &rpath_buf) else null;
        const new_ref = own_ref orelse rpath_ref orelse (loaderRelativeRef(allocator, tree_root, target, binary_path, &ref_buf) orelse target);
        if (std.mem.eql(u8, new_ref, dep.original_ref)) continue;

        // Fix the library path using install_name_tool
        const fix_result = try io_helper.childRun(allocator, &[_][]const u8{
            "install_name_tool",
            "-change",
            dep.original_ref,
            new_ref,
            binary_path,
        });
        defer allocator.free(fix_result.stdout);
        defer allocator.free(fix_result.stderr);
        if (fix_result.term != .exited or fix_result.term.exited != 0) return error.MacOSLibraryDependencyFixFailed;
    }
}

/// `@rpath/<domain>/v<major>/<rest>` for a library under a `/packages/` root,
/// through the `v<major>` link when it exists there, else the exact version;
/// null when `target` is not under a packages root.
pub fn packagesRpathRef(target: []const u8, out: []u8) ?[]const u8 {
    const marker = "/packages/";
    // The last one: the tree itself can sit under a path with `/packages/` in it.
    const idx = std.mem.lastIndexOf(u8, target, marker) orelse return null;
    const root = target[0 .. idx + marker.len - 1];
    const rel = target[idx + marker.len ..];
    var major_buf: [std.fs.max_path_bytes]u8 = undefined;
    var probe_buf: [std.fs.max_path_bytes]u8 = undefined;
    if (majorVersionRef(rel, &major_buf)) |major_rel| {
        const probe = std.fmt.bufPrint(&probe_buf, "{s}/{s}", .{ root, major_rel }) catch return null;
        if (io_helper.accessAbsolute(probe, .{})) |_| {
            return std.fmt.bufPrint(out, "@rpath/{s}", .{major_rel}) catch null;
        } else |_| {}
    }
    return std.fmt.bufPrint(out, "@rpath/{s}", .{rel}) catch null;
}

/// `@loader_path/<path of lib from binary's dir>` when `binary_path` and
/// `lib_path` are both inside `tree_root` (see `symlink.treeLinkTarget`),
/// written into `out`; null to keep the absolute path.
fn loaderRelativeRef(
    allocator: std.mem.Allocator,
    tree_root: ?[]const u8,
    lib_path: []const u8,
    binary_path: []const u8,
    out: []u8,
) ?[]const u8 {
    const rel = symlink.treeLinkTarget(allocator, tree_root, lib_path, binary_path) catch return null;
    defer allocator.free(rel);
    if (std.fs.path.isAbsolute(rel)) return null;
    return std.fmt.bufPrint(out, "@loader_path/{s}", .{rel}) catch null;
}

/// The directory `binary_path` sits in, as seen from itself: `@loader_path`
/// (macOS) or `$ORIGIN` (ELF) joined with `dir`'s path relative to it. A
/// package's own lib dir moves with the package, so this is always relative.
fn originRelativeDir(
    allocator: std.mem.Allocator,
    origin: []const u8,
    binary_path: []const u8,
    dir: []const u8,
) ?[]u8 {
    const from = std.fs.path.dirname(binary_path) orelse return null;
    const rel = std.fs.path.relative(allocator, "/", null, from, dir) catch return null;
    defer allocator.free(rel);
    if (rel.len == 0) return allocator.dupe(u8, origin) catch null;
    return std.fmt.allocPrint(allocator, "{s}/{s}", .{ origin, rel }) catch null;
}

test "originRelativeDir points a binary at its package's lib dir from where it sits" {
    const a = std.testing.allocator;
    const from_bin = originRelativeDir(a, "@loader_path", "/p/pantry/curl.se/v8.22.0/bin/curl", "/p/pantry/curl.se/v8.22.0/lib").?;
    defer a.free(from_bin);
    try std.testing.expectEqualStrings("@loader_path/../lib", from_bin);
    const from_lib = originRelativeDir(a, "$ORIGIN", "/p/pantry/curl.se/v8.22.0/lib/libcurl.so.4", "/p/pantry/curl.se/v8.22.0/lib").?;
    defer a.free(from_lib);
    try std.testing.expectEqualStrings("$ORIGIN", from_lib);
}

test "nested compiler runtime remains usable by a newly linked consumer" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];
    const pkg = try std.fmt.allocPrint(a, "{s}/pantry/example.org/v1.2.3", .{root});
    const nested = try std.fmt.allocPrint(a, "{s}/lib/clang/23/lib/darwin", .{pkg});
    try io_helper.makePath(nested);
    const source = try std.fmt.allocPrint(a, "{s}/probe.c", .{root});
    const main_source = try std.fmt.allocPrint(a, "{s}/main.c", .{root});
    const Writer = struct {
        fn write(path: []const u8, text: []const u8) !void {
            const file = try io_helper.createFileAbsolute(path, .{ .truncate = true });
            defer io_helper.closeFile(file);
            try io_helper.writeAllToFile(file, text);
        }
    };
    try Writer.write(source, "int answer(void) { return 42; }\n");
    try Writer.write(main_source, "#include <stdio.h>\nextern int answer(void);\nint main(void) { printf(\"%d\\n\", answer()); return 0; }\n");
    const dylib = try std.fmt.allocPrint(a, "{s}/libprobe.dylib", .{nested});
    const binary = try std.fmt.allocPrint(a, "{s}/consumer", .{root});
    const cc_lib = try io_helper.childRun(a, &.{ "/usr/bin/clang", "-arch", "arm64", "-arch", "x86_64", "-dynamiclib", source, "-Wl,-install_name,@rpath/example.org/v1.2.3/lib/clang/23/lib/darwin/libprobe.dylib", "-o", dylib });
    try std.testing.expect(cc_lib.term == .exited and cc_lib.term.exited == 0);

    // Symlink aliases and bundled applications belong to their own owners.
    const outside = try std.fmt.allocPrint(a, "{s}/outside.dylib", .{root});
    const bundled_dir = try std.fmt.allocPrint(a, "{s}/lib/Owned.app/Contents", .{pkg});
    try io_helper.makePath(bundled_dir);
    const bundled = try std.fmt.allocPrint(a, "{s}/bundled.dylib", .{bundled_dir});
    try io_helper.copyFile(dylib, outside);
    try io_helper.copyFile(dylib, bundled);
    try io_helper.symLink(outside, try std.fmt.allocPrint(a, "{s}/alias.dylib", .{nested}));
    try io_helper.symLink(bundled_dir, try std.fmt.allocPrint(a, "{s}/external", .{nested}));
    const untouched_id = try io_helper.childRun(a, &.{ "/usr/bin/otool", "-D", outside });

    try fixDirectoryLibraryPathsInTree(a, pkg, try std.fmt.allocPrint(a, "{s}/pantry", .{root}));
    const alias_package = try std.fmt.allocPrint(a, "{s}/alias-package", .{root});
    try io_helper.makePath(alias_package);
    try io_helper.symLink(bundled_dir, try std.fmt.allocPrint(a, "{s}/lib", .{alias_package}));
    try fixDirectoryLibraryPathsInTree(a, alias_package, null);
    const outside_id = try io_helper.childRun(a, &.{ "/usr/bin/otool", "-D", outside });
    try std.testing.expectEqualStrings(untouched_id.stdout, outside_id.stdout);
    const bundled_id = try io_helper.childRun(a, &.{ "/usr/bin/otool", "-D", bundled });
    try std.testing.expect(std.mem.indexOf(u8, bundled_id.stdout, "@rpath/example.org/v1.2.3/lib/clang/23/lib/darwin/libprobe.dylib") != null);
    // Existing installs reconcile again without changing the normalized ID.
    try fixDirectoryLibraryPathsInTree(a, pkg, try std.fmt.allocPrint(a, "{s}/pantry", .{root}));
    const rpath = try std.fmt.allocPrint(a, "-Wl,-rpath,{s}", .{nested});
    const cc_bin = try io_helper.childRun(a, &.{ "/usr/bin/clang", main_source, dylib, rpath, "-o", binary });
    try std.testing.expect(cc_bin.term == .exited and cc_bin.term.exited == 0);
    const run = try io_helper.childRun(a, &.{binary});
    if (run.term != .exited or run.term.exited != 0) std.debug.print("{s}\n", .{run.stderr});
    try std.testing.expect(run.term == .exited and run.term.exited == 0);
    try std.testing.expectEqualStrings("42\n", run.stdout);
    const id = try io_helper.childRun(a, &.{ "/usr/bin/otool", "-D", dylib });
    try std.testing.expect(id.term == .exited and id.term.exited == 0);
    try std.testing.expect(std.mem.indexOf(u8, id.stdout, "\n@rpath/libprobe.dylib\n") != null);
    var ids = std.mem.splitSequence(u8, id.stdout, "\n@rpath/libprobe.dylib\n");
    _ = ids.next();
    try std.testing.expect(ids.next() != null);
    try std.testing.expect(ids.next() != null);
    try std.testing.expect(ids.next() == null);
    const signed = try io_helper.childRun(a, &.{ "/usr/bin/codesign", "--verify", "--strict", dylib });
    try std.testing.expect(signed.term == .exited and signed.term.exited == 0);
}

test "nested compiler runtime identity preserves foreign and mixed architecture IDs" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];
    const lib_dir = try std.fmt.allocPrint(a, "{s}/pantry/example.org/v1.2.3/lib", .{root});
    try io_helper.makePath(lib_dir);
    const source = try std.fmt.allocPrint(a, "{s}/probe.c", .{root});
    const file = try io_helper.createFileAbsolute(source, .{ .truncate = true });
    try io_helper.writeAllToFile(file, "int answer(void) { return 42; }\n");
    io_helper.closeFile(file);
    const local_id = "@rpath/example.org/v1.2.3/lib/libprobe.dylib";
    const other_id = "@rpath/example.org/v1.2.3/lib/other.dylib";
    const unresolved_id = "@rpath/foreign.org/v9/lib/libprobe.dylib";
    const dylib = try std.fmt.allocPrint(a, "{s}/libprobe.dylib", .{lib_dir});
    const other = try std.fmt.allocPrint(a, "{s}/other.dylib", .{lib_dir});
    const thin = try std.fmt.allocPrint(a, "{s}/thin.dylib", .{root});
    const arm = try std.fmt.allocPrint(a, "{s}/arm.dylib", .{root});
    for ([_][]const u8{ other_id, unresolved_id, "/usr/lib/libprobe.dylib", "@loader_path/libprobe.dylib" }) |id| {
        const cc = try io_helper.childRun(a, &.{ "/usr/bin/clang", "-dynamiclib", source, try std.fmt.allocPrint(a, "-Wl,-install_name,{s}", .{id}), "-o", dylib });
        try std.testing.expect(cc.term == .exited and cc.term.exited == 0);
        // The other reference resolves, but to a different image.
        try io_helper.copyFile(dylib, other);
        const before = try io_helper.childRun(a, &.{ "/usr/bin/otool", "-D", dylib });
        try std.testing.expect(try fixDylibInstallName(a, dylib, lib_dir));
        const after = try io_helper.childRun(a, &.{ "/usr/bin/otool", "-D", dylib });
        try std.testing.expectEqualStrings(before.stdout, after.stdout);
    }
    for ([_][2][]const u8{
        .{ local_id, unresolved_id },
        .{ "/foreign/arm64/libprobe.dylib", "/foreign/x86_64/libprobe.dylib" },
    }) |identities| {
        for ([_]struct { arch: []const u8, id: []const u8, path: []const u8 }{
            .{ .arch = "arm64", .id = identities[0], .path = arm },
            .{ .arch = "x86_64", .id = identities[1], .path = thin },
        }) |slice| {
            const cc = try io_helper.childRun(a, &.{ "/usr/bin/clang", "-arch", slice.arch, "-dynamiclib", source, try std.fmt.allocPrint(a, "-Wl,-install_name,{s}", .{slice.id}), "-o", slice.path });
            try std.testing.expect(cc.term == .exited and cc.term.exited == 0);
        }
        const lipo = try io_helper.childRun(a, &.{ "/usr/bin/lipo", "-create", arm, thin, "-output", dylib });
        try std.testing.expect(lipo.term == .exited and lipo.term.exited == 0);
        const before = try io_helper.childRun(a, &.{ "/usr/bin/otool", "-D", dylib });
        try std.testing.expect(try fixDylibInstallName(a, dylib, lib_dir));
        const after = try io_helper.childRun(a, &.{ "/usr/bin/otool", "-D", dylib });
        try std.testing.expectEqualStrings(before.stdout, after.stdout);
    }
}

/// Resolve an `@rpath`-relative registry path (`<domain>/v<ver>/lib/<name>`)
/// against the ancestors of a package's lib dir, nearest first, returning the
/// first that exists. The packages root is a few levels up — how many depends
/// on how many slashes the package's own domain has — so each is tried.
pub fn findRpathRefInAncestors(lib_dir: []const u8, rel: []const u8, out: []u8) ?[]const u8 {
    if (rel.len == 0 or rel[0] == '/' or std.mem.indexOf(u8, rel, "..") != null) return null;
    var dir = lib_dir;
    var depth: usize = 0;
    while (depth < 8) : (depth += 1) {
        dir = std.fs.path.dirname(dir) orelse return null;
        if (dir.len <= 1) return null;
        const candidate = std.fmt.bufPrint(out, "{s}/{s}", .{ dir, rel }) catch return null;
        if (io_helper.accessAbsolute(candidate, .{})) |_| return candidate else |_| {}
    }
    return null;
}

/// `<domain>/v<major>.<minor>.../<rest>` as `<domain>/v<major>/<rest>`, or null
/// when the path has no dotted version segment. The domain can have slashes
/// of its own (`sourceware.org/libffi`), so the first segment shaped like
/// `v<digit>...` with a dot in it is the version.
pub fn majorVersionRef(rel: []const u8, out: []u8) ?[]const u8 {
    var start: usize = 0;
    while (start < rel.len) {
        const end = std.mem.indexOfScalarPos(u8, rel, start, '/') orelse return null;
        const segment = rel[start..end];
        if (segment.len >= 3 and segment[0] == 'v' and std.ascii.isDigit(segment[1])) {
            const dot = std.mem.indexOfScalar(u8, segment, '.') orelse return null;
            const major = segment[1..dot];
            for (major) |c| if (!std.ascii.isDigit(c)) return null;
            return std.fmt.bufPrint(out, "{s}v{s}{s}", .{ rel[0..start], major, rel[end..] }) catch null;
        }
        start = end + 1;
    }
    return null;
}

/// Given a package's lib dir (`<...>/packages/<domain>/v<ver>/lib`), locate a
/// dylib named `basename` provided by ANY other installed package, returning its
/// absolute path written into `out`. Used to repoint hardcoded Homebrew/abs
/// references (e.g. libssl.3.dylib) at the matching pantry package. Searches
/// `<packages-root>/**/lib/<basename>` to a bounded depth.
fn findDylibInPackages(allocator: std.mem.Allocator, lib_dir: []const u8, basename: []const u8, out: []u8) ?[]const u8 {
    const marker = "/packages/";
    // The last one: a pantry tree under `~/Code/x/packages/...` has two.
    const idx = std.mem.lastIndexOf(u8, lib_dir, marker) orelse return null;
    const packages_root = lib_dir[0 .. idx + marker.len - 1]; // includes "/packages"
    return searchLibDirs(allocator, packages_root, basename, out, 0);
}

fn searchLibDirs(allocator: std.mem.Allocator, dir_path: []const u8, basename: []const u8, out: []u8, depth: usize) ?[]const u8 {
    if (depth > 4) return null;
    var dir = io_helper.openDirAbsoluteForIteration(dir_path) catch return null;
    defer dir.close();
    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (entry.name.len > 0 and entry.name[0] == '.') continue;
        const child = std.fmt.allocPrint(allocator, "{s}/{s}", .{ dir_path, entry.name }) catch continue;
        defer allocator.free(child);
        if (entry.kind == .directory) {
            // When we reach a `lib` dir, check for the basename directly.
            if (std.mem.eql(u8, entry.name, "lib")) {
                const candidate = std.fmt.allocPrint(allocator, "{s}/{s}", .{ child, basename }) catch continue;
                defer allocator.free(candidate);
                if (io_helper.accessAbsolute(candidate, .{})) |_| {
                    if (candidate.len <= out.len) {
                        @memcpy(out[0..candidate.len], candidate);
                        return out[0..candidate.len];
                    }
                } else |_| {}
            }
            if (searchLibDirs(allocator, child, basename, out, depth + 1)) |p| return p;
        }
    }
    return null;
}

/// Add rpath entries to a binary for finding dependencies
fn addRpathEntries(
    allocator: std.mem.Allocator,
    binary_path: []const u8,
    package_dir: []const u8,
) !void {
    const builtin = @import("builtin");
    if (builtin.os.tag != .macos) return;

    // Resolve the canonical user-level global dir so dynamic libs in
    // `<global>/packages/<dep>/v<ver>/lib` (openssl.org, nodejs.org, etc.)
    // remain reachable from a freshly installed binary's rpath.
    const global = try Paths.globalDir(allocator);
    defer allocator.free(global);

    // Add rpath entries for:
    // 1. The package's own lib directory
    // 2. The global pantry directory (for finding openssl.org, nodejs.org, etc.)
    // The package's own lib dir is named relative to the binary
    // (`@loader_path/../lib`), so it survives the package moving.
    var rp_buf1: [std.fs.max_path_bytes]u8 = undefined;
    const pkg_lib = std.fmt.bufPrint(&rp_buf1, "{s}/lib", .{package_dir}) catch return;
    const rp1 = originRelativeDir(allocator, "@loader_path", binary_path, pkg_lib) orelse return;
    defer allocator.free(rp1);
    var rp_buf2: [std.fs.max_path_bytes]u8 = undefined;
    const rp2 = std.fmt.bufPrint(&rp_buf2, "{s}", .{global}) catch return;
    const rpath_entries = [_][]const u8{ rp1, rp2 };

    // Inspect first so scripts are skipped and duplicate RPATHs are true no-ops.
    const commands = try io_helper.childRun(allocator, &.{ "otool", "-l", binary_path });
    defer allocator.free(commands.stdout);
    defer allocator.free(commands.stderr);
    if (commands.term != .exited or commands.term.exited != 0) return;
    // The image's own LC_ID_DYLIB is a linker identity, not a runtime
    // dependency. Adding unused paths can overflow an otherwise valid header.
    if (!hasRpathDependencies(commands.stdout)) return;
    for (rpath_entries) |rpath| {
        const coverage = rpathArchitectureCoverage(commands.stdout, rpath);
        if (coverage.architectures > 0 and coverage.matching == coverage.architectures) continue;
        if (coverage.matching > 0) {
            try addRpathToMissingArchitectures(allocator, binary_path, rpath);
            continue;
        }
        const result = try io_helper.childRun(allocator, &.{ "install_name_tool", "-add_rpath", rpath, binary_path });
        defer allocator.free(result.stdout);
        defer allocator.free(result.stderr);
        if (result.term != .exited or result.term.exited != 0) {
            style.printError("Could not add RPATH to {s}: {s}", .{ binary_path, result.stderr });
            if (@import("builtin").is_test) std.debug.print("RPATH {s}: {s}\n", .{ rpath, result.stderr });
            return error.MacOSLibraryRpathFixFailed;
        }
    }
}

fn hasRpathDependencies(commands: []const u8) bool {
    var dependency = false;
    var lines = std.mem.tokenizeScalar(u8, commands, '\n');
    while (lines.next()) |line| {
        const text = std.mem.trim(u8, line, " \t\r");
        if (std.mem.startsWith(u8, text, "cmd ")) {
            dependency = std.mem.eql(u8, text, "cmd LC_LOAD_DYLIB") or
                std.mem.eql(u8, text, "cmd LC_LOAD_WEAK_DYLIB") or
                std.mem.eql(u8, text, "cmd LC_REEXPORT_DYLIB") or
                std.mem.eql(u8, text, "cmd LC_LOAD_UPWARD_DYLIB");
        } else if (dependency and std.mem.startsWith(u8, text, "name @rpath/")) return true;
    }
    return false;
}

fn rpathArchitectureCoverage(commands: []const u8, rpath: []const u8) struct { architectures: usize, matching: usize } {
    var architectures: usize = 0;
    var matching: usize = 0;
    var in_rpath = false;
    var found_in_architecture = false;
    var lines = std.mem.tokenizeScalar(u8, commands, '\n');
    while (lines.next()) |line| {
        const text = std.mem.trim(u8, line, " \t\r");
        if (std.mem.endsWith(u8, text, ":")) {
            architectures += 1;
            found_in_architecture = false;
            in_rpath = false;
        } else if (std.mem.startsWith(u8, text, "cmd ")) {
            in_rpath = std.mem.eql(u8, text, "cmd LC_RPATH");
        } else if (in_rpath and !found_in_architecture and std.mem.startsWith(u8, text, "path ")) {
            const end = std.mem.lastIndexOf(u8, text, " (offset ") orelse continue;
            if (std.mem.eql(u8, text["path ".len..end], rpath)) {
                matching += 1;
                found_in_architecture = true;
            }
        }
    }
    return .{ .architectures = architectures, .matching = matching };
}

fn hasRpathInEveryArchitecture(commands: []const u8, rpath: []const u8) bool {
    const coverage = rpathArchitectureCoverage(commands, rpath);
    return coverage.architectures > 0 and coverage.matching == coverage.architectures;
}

// install_name_tool has no per-architecture option and rejects an add if
// any slice already has that path. Rebuild only this mixed case in private
// sibling staging, preserving all other slice commands and the file mode.
fn addRpathToMissingArchitectures(allocator: std.mem.Allocator, binary_path: []const u8, rpath: []const u8) !void {
    const archs = try io_helper.childRun(allocator, &.{ "lipo", "-archs", binary_path });
    defer allocator.free(archs.stdout);
    defer allocator.free(archs.stderr);
    if (archs.term != .exited or archs.term.exited != 0) return error.MacOSLibraryArchitectureReadFailed;
    const metadata = try io_helper.cwd().statFile(io_helper.io, binary_path, .{ .follow_symlinks = false });
    if (metadata.kind != .file) return error.MacOSLibraryArchitectureReadFailed;
    const staging = try io_helper.createPrivateDirectory(allocator, std.fs.path.dirname(binary_path) orelse return error.InvalidPath, ".pantry-rpath");
    defer allocator.free(staging);
    defer io_helper.deleteTree(staging) catch {};
    var merge = try std.ArrayList([]const u8).initCapacity(allocator, 8);
    defer {
        for (merge.items[2..]) |path| allocator.free(path);
        merge.deinit(allocator);
    }
    try merge.appendSlice(allocator, &.{ "lipo", "-create" });
    var names = std.mem.tokenizeAny(u8, archs.stdout, " \t\r\n");
    while (names.next()) |arch| {
        for (arch) |c| if (!std.ascii.isAlphanumeric(c) and c != '_') return error.MacOSLibraryArchitectureReadFailed;
        const slice = try std.fs.path.join(allocator, &.{ staging, arch });
        // Keep slice paths owned by merge, including all error exits.
        merge.append(allocator, slice) catch |err| {
            allocator.free(slice);
            return err;
        };
        const thin = try io_helper.childRun(allocator, &.{ "lipo", binary_path, "-thin", arch, "-output", slice });
        defer allocator.free(thin.stdout);
        defer allocator.free(thin.stderr);
        if (thin.term != .exited or thin.term.exited != 0) return error.MacOSLibraryArchitectureReadFailed;
        const commands = try io_helper.childRun(allocator, &.{ "otool", "-l", slice });
        defer allocator.free(commands.stdout);
        defer allocator.free(commands.stderr);
        if (commands.term != .exited or commands.term.exited != 0) return error.MacOSLibraryArchitectureReadFailed;
        if (!hasRpathInEveryArchitecture(commands.stdout, rpath)) {
            const add = try io_helper.childRun(allocator, &.{ "install_name_tool", "-add_rpath", rpath, slice });
            defer allocator.free(add.stdout);
            defer allocator.free(add.stderr);
            if (add.term != .exited or add.term.exited != 0) return error.MacOSLibraryRpathFixFailed;
        }
    }
    if (merge.items.len < 4) return error.MacOSLibraryArchitectureReadFailed;
    const output = try std.fs.path.join(allocator, &.{ staging, "rebuilt" });
    defer allocator.free(output);
    // The tail is borrowed, unlike the owned slice paths above.
    const owned_len = merge.items.len;
    try merge.appendSlice(allocator, &.{ "-output", output });
    const combined = io_helper.childRun(allocator, merge.items) catch |err| {
        merge.shrinkRetainingCapacity(owned_len);
        return err;
    };
    merge.shrinkRetainingCapacity(owned_len);
    defer allocator.free(combined.stdout);
    defer allocator.free(combined.stderr);
    if (combined.term != .exited or combined.term.exited != 0) return error.MacOSLibraryArchitectureWriteFailed;
    const file = try io_helper.cwd().openFile(io_helper.io, output, .{ .mode = .read_write });
    defer io_helper.closeFile(file);
    try file.setPermissions(io_helper.io, metadata.permissions);
    try io_helper.rename(output, binary_path);
}

test "library normalization fills missing universal RPATHs and preserves other slice paths" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];
    const bin = try std.fs.path.join(a, &.{ root, "bin" });
    const lib = try std.fs.path.join(a, &.{ root, "lib" });
    try io_helper.makePath(bin);
    try io_helper.makePath(lib);
    const source = try std.fs.path.join(a, &.{ root, "main.c" });
    const library_source = try std.fs.path.join(a, &.{ root, "probe.c" });
    for ([_][2][]const u8{
        .{ source, "#include <stdio.h>\nextern int answer(void);\nint main(void) { printf(\"%d\\n\", answer()); return 0; }\n" },
        .{ library_source, "int answer(void) { return 42; }\n" },
    }) |entry| {
        const file = try io_helper.createFileAbsolute(entry[0], .{});
        defer io_helper.closeFile(file);
        try io_helper.writeAllToFile(file, entry[1]);
    }
    const library = try std.fs.path.join(a, &.{ lib, "libprobe.dylib" });
    const cc_lib = try io_helper.childRun(a, &.{ "/usr/bin/clang", "-arch", "arm64", "-arch", "x86_64", "-dynamiclib", library_source, "-Wl,-install_name,@rpath/libprobe.dylib", "-o", library });
    try std.testing.expect(cc_lib.term == .exited and cc_lib.term.exited == 0);
    const arm = try std.fs.path.join(a, &.{ root, "arm" });
    const intel = try std.fs.path.join(a, &.{ root, "intel" });
    const binary = try std.fs.path.join(a, &.{ bin, "consumer" });
    const cc_arm = try io_helper.childRun(a, &.{ "/usr/bin/clang", "-arch", "arm64", source, library, "-Wl,-headerpad,4096", "-Wl,-rpath,@loader_path/../lib", "-Wl,-rpath,@loader_path/arm-only", "-o", arm });
    try std.testing.expect(cc_arm.term == .exited and cc_arm.term.exited == 0);
    const cc_intel = try io_helper.childRun(a, &.{ "/usr/bin/clang", "-arch", "x86_64", source, library, "-Wl,-headerpad,4096", "-Wl,-rpath,@loader_path/intel-only", "-o", intel });
    try std.testing.expect(cc_intel.term == .exited and cc_intel.term.exited == 0);
    const merged = try io_helper.childRun(a, &.{ "lipo", "-create", arm, intel, "-output", binary });
    try std.testing.expect(merged.term == .exited and merged.term.exited == 0);
    const original_metadata = try io_helper.cwd().statFile(io_helper.io, binary, .{});
    try addRpathEntries(a, binary, root);
    try addRpathEntries(a, binary, root);
    const final_metadata = try io_helper.cwd().statFile(io_helper.io, binary, .{});
    try std.testing.expectEqual(original_metadata.permissions.toMode(), final_metadata.permissions.toMode());
    const commands = try io_helper.childRun(a, &.{ "otool", "-l", binary });
    const global = try Paths.globalDir(a);
    try std.testing.expect(hasRpathInEveryArchitecture(commands.stdout, "@loader_path/../lib"));
    try std.testing.expect(hasRpathInEveryArchitecture(commands.stdout, global));
    const arm_commands = try io_helper.childRun(a, &.{ "otool", "-arch", "arm64", "-l", binary });
    const intel_commands = try io_helper.childRun(a, &.{ "otool", "-arch", "x86_64", "-l", binary });
    try std.testing.expect(hasRpathInEveryArchitecture(arm_commands.stdout, "@loader_path/arm-only"));
    try std.testing.expect(hasRpathInEveryArchitecture(intel_commands.stdout, "@loader_path/intel-only"));
    try codesignDirectory(a, bin);
    const run = try io_helper.childRun(a, &.{binary});
    if (run.term != .exited or run.term.exited != 0) std.debug.print("{s}\n", .{run.stderr});
    try std.testing.expect(run.term == .exited and run.term.exited == 0);
    try std.testing.expectEqualStrings("42\n", run.stdout);
}

test "library normalization RPATH inspection requires each universal slice" {
    const both = "lib (architecture arm64):\ncmd LC_RPATH\npath @loader_path/lib with spaces (offset 12)\nlib (architecture x86_64):\ncmd LC_RPATH\npath @loader_path/lib with spaces (offset 12)\n";
    try std.testing.expect(hasRpathInEveryArchitecture(both, "@loader_path/lib with spaces"));
    try std.testing.expect(!hasRpathInEveryArchitecture(both, "@loader_path/lib"));
    const partial = both ++ "lib (architecture x86_64h):\ncmd LC_LOAD_DYLIB\npath @loader_path/lib with spaces (offset 12)\n";
    try std.testing.expect(!hasRpathInEveryArchitecture(partial, "@loader_path/lib with spaces"));
    try std.testing.expect(!hasRpathInEveryArchitecture("", "anything"));
    try std.testing.expect(!hasRpathDependencies("cmd LC_ID_DYLIB\nname @rpath/libprobe.dylib (offset 24)\ncmd LC_LOAD_DYLIB\nname /usr/lib/libSystem.B.dylib (offset 24)\n"));
    try std.testing.expect(hasRpathDependencies("cmd LC_LOAD_WEAK_DYLIB\nname @rpath/libprobe.dylib (offset 24)\n"));
}

/// Normalize a proven package-store identity or a hardcoded build path.
fn fixDylibInstallName(
    allocator: std.mem.Allocator,
    dylib_path: []const u8,
    lib_dir: []const u8,
) !bool {
    const builtin = @import("builtin");
    if (builtin.os.tag != .macos) return false;

    // Use otool -D to get the install name
    const otool_result = try io_helper.childRun(allocator, &[_][]const u8{
        "otool", "-D", dylib_path,
    });
    defer allocator.free(otool_result.stdout);
    defer allocator.free(otool_result.stderr);

    if (otool_result.term != .exited or otool_result.term.exited != 0) return false;

    // Universal images report one header and ID per architecture. Only rewrite
    // when every slice agrees on the same proven identity; -id changes all of
    // them, so checking just the first could overwrite a different slice's ID.
    const Identity = enum { rpath, absolute };
    var identity: ?Identity = null;
    var needs_change = false;
    var found_id = false;
    var absolute_id: ?[]const u8 = null;
    var new_id_buf: [std.fs.max_path_bytes]u8 = undefined;
    const rpath_id = try std.fmt.bufPrint(&new_id_buf, "@rpath/{s}", .{std.fs.path.basename(dylib_path)});
    var lines_iter = std.mem.tokenizeScalar(u8, otool_result.stdout, '\n');
    while (lines_iter.next()) |line| {
        const install_name = std.mem.trim(u8, line, " \t\r");
        if (std.mem.endsWith(u8, install_name, ":")) continue;
        found_id = true;
        const proposed: Identity = if (std.mem.startsWith(u8, install_name, "@rpath/")) blk: {
            if (std.mem.eql(u8, install_name, rpath_id)) break :blk .rpath;
            // A compiler supplies its runtime's directory to the linker. An ID
            // rooted at the package store repeats that store beneath it.
            var resolved_buf: [std.fs.max_path_bytes]u8 = undefined;
            const resolved = findRpathRefInAncestors(lib_dir, install_name["@rpath/".len..], &resolved_buf) orelse return true;
            const actual = try io_helper.realpathAlloc(allocator, dylib_path);
            defer allocator.free(actual);
            const target = try io_helper.realpathAlloc(allocator, resolved);
            defer allocator.free(target);
            if (!std.mem.eql(u8, actual, target)) return true;
            break :blk .rpath;
        } else blk: {
            if (install_name.len == 0 or install_name[0] != '/') return true;
            for ([_][]const u8{ "/usr/lib/", "/System/Library/", "/Library/Apple/" }) |prefix| {
                if (std.mem.startsWith(u8, install_name, prefix)) return true;
            }
            if (absolute_id) |previous| {
                if (!std.mem.eql(u8, previous, install_name)) return true;
            } else absolute_id = install_name;
            break :blk .absolute;
        };
        if (identity) |previous| {
            if (previous != proposed) return true;
        } else identity = proposed;
        const desired = if (proposed == .rpath) rpath_id else dylib_path;
        needs_change = needs_change or !std.mem.eql(u8, install_name, desired);
    }
    if (!found_id) return false;
    if (!needs_change) return true;
    const new_id = if (identity.? == .rpath) rpath_id else dylib_path;

    // Fix the install name
    const result = try io_helper.childRun(allocator, &[_][]const u8{
        "install_name_tool", "-id", new_id, dylib_path,
    });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    if (result.term != .exited or result.term.exited != 0) return error.MacOSLibraryIdentityFixFailed;
    return true;
}

fn fixMacOSLibraryDirectory(
    allocator: std.mem.Allocator,
    directory: []const u8,
    lib_dir: []const u8,
    package_dir: []const u8,
    tree_root: []const u8,
) !void {
    const metadata = try io_helper.cwd().statFile(io_helper.io, directory, .{ .follow_symlinks = false });
    if (metadata.kind != .directory) return;
    var dir = try io_helper.openDirAbsoluteForIteration(directory);
    defer dir.close();
    var iterator = dir.iterate();
    while (try iterator.next()) |entry| {
        const path = try std.fs.path.join(allocator, &.{ directory, entry.name });
        defer allocator.free(path);
        if (entry.kind == .directory and !std.mem.endsWith(u8, entry.name, ".app")) {
            try fixMacOSLibraryDirectory(allocator, path, lib_dir, package_dir, tree_root);
        } else if (entry.kind == .file and std.mem.endsWith(u8, entry.name, ".dylib")) {
            if (!try fixDylibInstallName(allocator, path, lib_dir)) continue;
            try fixMacOSLibraryPathsInTree(allocator, path, lib_dir, tree_root);
            try addRpathEntries(allocator, path, package_dir);
            const signed = try io_helper.childRun(allocator, &.{ "codesign", "-s", "-", "-f", path });
            defer allocator.free(signed.stdout);
            defer allocator.free(signed.stderr);
            if (signed.term != .exited or signed.term.exited != 0) return error.MacOSLibrarySigningFailed;
        }
    }
}

/// Fix ELF RPATH/RUNPATH entries on Linux using `patchelf`.
/// Adds `$ORIGIN/../lib` (so binaries find sibling `lib/`) plus the package's
/// lib dir as a fallback. Silently skipped if `patchelf` isn't on PATH — we
/// treat it as best-effort because most prebuilt tarballs already have sane
/// RPATH. For packages that hardcode a build-time absolute path, this is the
/// Linux equivalent of the macOS `install_name_tool` dance above.
pub fn fixLinuxRpaths(
    allocator: std.mem.Allocator,
    binary_path: []const u8,
    lib_dir: []const u8,
) !void {
    const builtin = @import("builtin");
    if (builtin.os.tag != .linux) return;

    // Skip anything that isn't ELF — cheap magic byte check to avoid spawning
    // patchelf on scripts, symlinks to /dev/null, etc.
    {
        const f = io_helper.cwd().openFile(io_helper.io, binary_path, .{ .mode = .read_only }) catch return;
        defer f.close(io_helper.io);
        var magic: [4]u8 = undefined;
        const n = io_helper.platformRead(f.handle, &magic) catch return;
        if (n < 4) return;
        if (magic[0] != 0x7f or magic[1] != 'E' or magic[2] != 'L' or magic[3] != 'F') return;
    }

    // Build the rpath list: "$ORIGIN/../lib" plus the package's lib dir as
    // seen from this binary (`$ORIGIN` for a library inside it). Both are
    // relative to the binary, so the package keeps working when moved.
    const own_lib = originRelativeDir(allocator, "$ORIGIN", binary_path, lib_dir) orelse return;
    defer allocator.free(own_lib);
    const rpath = if (std.mem.eql(u8, own_lib, "$ORIGIN/../lib"))
        try allocator.dupe(u8, own_lib)
    else
        try std.fmt.allocPrint(allocator, "$ORIGIN/../lib:{s}", .{own_lib});
    defer allocator.free(rpath);

    // Try `patchelf --force-rpath --set-rpath <rpath> <binary>`. We use
    // `--force-rpath` so we don't depend on the kernel honouring DT_RUNPATH.
    const result = io_helper.childRun(allocator, &[_][]const u8{
        "patchelf", "--force-rpath", "--set-rpath", rpath, binary_path,
    }) catch {
        return;
    };
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    if (result.term != .exited or result.term.exited != 0) {
        // patchelf failed (not ELF, or not dynamically linked) — nothing more we can do.
        return;
    }
}

/// Fix library paths for all executables and dylibs in a package directory
/// This includes both binaries in bin/ and libraries in lib/
pub fn fixDirectoryLibraryPaths(
    allocator: std.mem.Allocator,
    package_dir: []const u8,
) !void {
    return fixDirectoryLibraryPathsInTree(allocator, package_dir, null);
}

/// `fixDirectoryLibraryPaths` for a package installed in the pantry tree at
/// `tree_root` (`<project>/pantry`): references to libraries elsewhere in
/// that tree are written relative to the referencing binary.
pub fn fixDirectoryLibraryPathsInTree(
    allocator: std.mem.Allocator,
    package_dir: []const u8,
    tree_root: ?[]const u8,
) !void {
    const builtin = @import("builtin");
    // Linux-only path: walk bin/ and lib/ and patch ELF rpaths
    if (builtin.os.tag == .linux) {
        var bin_buf: [std.fs.max_path_bytes]u8 = undefined;
        const bin_dir = std.fmt.bufPrint(&bin_buf, "{s}/bin", .{package_dir}) catch return;
        var lib_buf: [std.fs.max_path_bytes]u8 = undefined;
        const lib_dir = std.fmt.bufPrint(&lib_buf, "{s}/lib", .{package_dir}) catch return;

        io_helper.accessAbsolute(lib_dir, .{}) catch return;

        // bin/
        if (io_helper.openDirAbsoluteForIteration(bin_dir)) |*dir_ptr| {
            var dir = dir_ptr.*;
            defer dir.close();
            var it = dir.iterate();
            while (it.next() catch null) |entry| {
                if (entry.kind != .file) continue;
                var bp: [std.fs.max_path_bytes]u8 = undefined;
                const p = std.fmt.bufPrint(&bp, "{s}/{s}", .{ bin_dir, entry.name }) catch continue;
                fixLinuxRpaths(allocator, p, lib_dir) catch {};
            }
        } else |_| {}

        // lib/
        if (io_helper.openDirAbsoluteForIteration(lib_dir)) |*dir_ptr| {
            var dir = dir_ptr.*;
            defer dir.close();
            var it = dir.iterate();
            while (it.next() catch null) |entry| {
                if (entry.kind != .file) continue;
                if (std.mem.indexOf(u8, entry.name, ".so") == null) continue;
                var lp: [std.fs.max_path_bytes]u8 = undefined;
                const p = std.fmt.bufPrint(&lp, "{s}/{s}", .{ lib_dir, entry.name }) catch continue;
                fixLinuxRpaths(allocator, p, lib_dir) catch {};
            }
        } else |_| {}

        return;
    }
    if (builtin.os.tag != .macos) return;

    // Build paths to bin and lib directories using stack buffers
    var bin_buf: [std.fs.max_path_bytes]u8 = undefined;
    const bin_dir = std.fmt.bufPrint(&bin_buf, "{s}/bin", .{package_dir}) catch return;

    var lib_buf: [std.fs.max_path_bytes]u8 = undefined;
    const lib_dir = std.fmt.bufPrint(&lib_buf, "{s}/lib", .{package_dir}) catch return;

    // Check if lib directory exists (we need it for absolute paths)
    const lib_metadata = io_helper.cwd().statFile(io_helper.io, lib_dir, .{ .follow_symlinks = false }) catch |err| {
        if (err == error.FileNotFound) return;
        return err;
    };
    if (lib_metadata.kind != .directory) return;

    // Compiler runtimes and other libraries can live below lib/. Each real
    // image is normalized and signed before a successful install is recorded.
    try fixMacOSLibraryDirectory(allocator, lib_dir, lib_dir, package_dir, tree_root orelse package_dir);

    // Fix binaries in bin/ directory. A missing bin/ (library-only packages like
    // zlib.net, openssl.org, libexpat) must NOT abort: the rpath rewrites above
    // already invalidated the dylib signatures, so we have to fall through to the
    // re-sign step below. Using `catch return` here meant those dylibs were left
    // with broken ad-hoc signatures, and on Apple Silicon dyld then SIGKILLs any
    // binary that loads them (git, codex, …).
    //
    // sbin/ holds daemons (php-fpm, mysqld in some layouts) whose references
    // need the same rewrite: php.net's sbin/php-fpm kept its dangling
    // `@rpath/sourceware.org/libffi/v3.6.0/...` after bin/php was fixed, and
    // dyld refused to start it.
    var sbin_buf: [std.fs.max_path_bytes]u8 = undefined;
    const sbin_dir = std.fmt.bufPrint(&sbin_buf, "{s}/sbin", .{package_dir}) catch return;
    for ([_][]const u8{ bin_dir, sbin_dir }) |exec_dir| {
        const metadata = io_helper.cwd().statFile(io_helper.io, exec_dir, .{ .follow_symlinks = false }) catch |err| {
            if (err == error.FileNotFound) continue;
            return err;
        };
        if (metadata.kind != .directory) continue;
        if (io_helper.openDirAbsoluteForIteration(exec_dir)) |*dir_ptr| {
            var dir = dir_ptr.*;
            defer dir.close();

            var it = dir.iterate();
            while (try it.next()) |entry| {
                if (entry.kind != .file) continue;

                var bp_buf: [std.fs.max_path_bytes]u8 = undefined;
                const binary_path = std.fmt.bufPrint(&bp_buf, "{s}/{s}", .{ exec_dir, entry.name }) catch continue;

                try fixMacOSLibraryPathsInTree(allocator, binary_path, lib_dir, tree_root orelse package_dir);
                try addRpathEntries(allocator, binary_path, package_dir);
            }
        } else |err| return err;
    }

    // Re-sign all modified binaries and dylibs. This MUST run even when bin/ is
    // absent — see the note above.
    try codesignDirectory(allocator, bin_dir);
    try codesignDirectory(allocator, sbin_dir);
}

/// Re-sign all Mach-O files in a directory after modifications
fn codesignDirectory(allocator: std.mem.Allocator, dir_path: []const u8) !void {
    const metadata = io_helper.cwd().statFile(io_helper.io, dir_path, .{ .follow_symlinks = false }) catch |err| {
        if (err == error.FileNotFound) return;
        return err;
    };
    if (metadata.kind != .directory) return;
    var dir = try io_helper.openDirAbsoluteForIteration(dir_path);
    defer dir.close();

    var it = dir.iterate();
    while (try it.next()) |entry| {
        if (entry.kind != .file) continue;

        var path_buf: [std.fs.max_path_bytes]u8 = undefined;
        const file_path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ dir_path, entry.name }) catch continue;

        const image = try io_helper.childRun(allocator, &.{ "otool", "-h", file_path });
        defer allocator.free(image.stdout);
        defer allocator.free(image.stderr);
        if (image.term != .exited or image.term.exited != 0) continue;
        const result = try io_helper.childRun(allocator, &[_][]const u8{
            "codesign", "-s", "-", "-f", file_path,
        });
        defer allocator.free(result.stdout);
        defer allocator.free(result.stderr);
        if (result.term != .exited or result.term.exited != 0) return error.MacOSLibrarySigningFailed;
    }
}

test "an @rpath registry reference resolves against a project install's root" {
    const testing = std.testing;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];

    // <proj>/pantry/<domain>/v<ver>/lib, as `pantry install` lays it out.
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const bz_lib = try std.fmt.bufPrint(&buf, "{s}/pantry/sourceware.org/bzip2/v1.0.8/lib", .{root});
    try io_helper.makePath(bz_lib);
    var file_buf: [std.fs.max_path_bytes]u8 = undefined;
    const bz = try std.fmt.bufPrint(&file_buf, "{s}/libbz2.1.0.8.dylib", .{bz_lib});
    io_helper.closeFile(try io_helper.createFileAbsolute(bz, .{}));

    var lib_buf: [std.fs.max_path_bytes]u8 = undefined;
    const xorriso_lib = try std.fmt.bufPrint(&lib_buf, "{s}/pantry/gnu.org/xorriso/v1.5.4/lib", .{root});
    try io_helper.makePath(xorriso_lib);

    var out: [std.fs.max_path_bytes]u8 = undefined;
    const found = findRpathRefInAncestors(xorriso_lib, "sourceware.org/bzip2/v1.0.8/lib/libbz2.1.0.8.dylib", &out) orelse
        return error.TestExpectedResolution;
    try testing.expectEqualStrings(bz, found);

    try testing.expect(findRpathRefInAncestors(xorriso_lib, "example.com/missing/v1/lib/libx.dylib", &out) == null);
    try testing.expect(findRpathRefInAncestors(xorriso_lib, "../../etc/passwd", &out) == null);
}

test "majorVersionRef keeps the domain and file, and drops all but the major" {
    var out: [256]u8 = undefined;
    try std.testing.expectEqualStrings(
        "sourceware.org/libffi/v3/lib/libffi.8.dylib",
        majorVersionRef("sourceware.org/libffi/v3.6.0/lib/libffi.8.dylib", &out).?,
    );
    try std.testing.expectEqualStrings("zlib.net/v1/lib/libz.1.dylib", majorVersionRef("zlib.net/v1.3.2/lib/libz.1.dylib", &out).?);
    // Already a major link, or no version at all: nothing to fall back to.
    try std.testing.expect(majorVersionRef("zlib.net/v1/lib/libz.1.dylib", &out) == null);
    try std.testing.expect(majorVersionRef("libz.1.dylib", &out) == null);
}

test "an @rpath reference to a version not installed resolves through its major link" {
    const testing = std.testing;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];

    // libffi 3.8.0 is installed, with the v3 link pantry keeps beside it.
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const ffi_lib = try std.fmt.bufPrint(&buf, "{s}/pantry/sourceware.org/libffi/v3.8.0/lib", .{root});
    try io_helper.makePath(ffi_lib);
    var file_buf: [std.fs.max_path_bytes]u8 = undefined;
    io_helper.closeFile(try io_helper.createFileAbsolute(try std.fmt.bufPrint(&file_buf, "{s}/libffi.8.dylib", .{ffi_lib}), .{}));
    var link_buf: [std.fs.max_path_bytes]u8 = undefined;
    const link = try std.fmt.bufPrint(&link_buf, "{s}/pantry/sourceware.org/libffi/v3", .{root});
    try io_helper.symLink("v3.8.0", link);

    var lib_buf: [std.fs.max_path_bytes]u8 = undefined;
    const php_lib = try std.fmt.bufPrint(&lib_buf, "{s}/pantry/php.net/v8.5.8/lib", .{root});
    try io_helper.makePath(php_lib);

    // php was built against 3.6.0, which is not here.
    const rel = "sourceware.org/libffi/v3.6.0/lib/libffi.8.dylib";
    var out: [std.fs.max_path_bytes]u8 = undefined;
    try testing.expect(findRpathRefInAncestors(php_lib, rel, &out) == null);

    var major_buf: [std.fs.max_path_bytes]u8 = undefined;
    const found = findRpathRefInAncestors(php_lib, majorVersionRef(rel, &major_buf).?, &out) orelse
        return error.TestExpectedResolution;
    var want_buf: [std.fs.max_path_bytes]u8 = undefined;
    try testing.expectEqualStrings(try std.fmt.bufPrint(&want_buf, "{s}/pantry/sourceware.org/libffi/v3/lib/libffi.8.dylib", .{root}), found);
}

test "a library found in another package is referenced through @rpath and its major link" {
    const testing = std.testing;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];

    // harfbuzz 14.6.0 is installed with its v14 link; ffmpeg was built against v8.
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const hb_lib = try std.fmt.bufPrint(&buf, "{s}/packages/harfbuzz.org/v14.6.0/lib", .{root});
    try io_helper.makePath(hb_lib);
    var file_buf: [std.fs.max_path_bytes]u8 = undefined;
    const dylib = try std.fmt.bufPrint(&file_buf, "{s}/libharfbuzz.dylib", .{hb_lib});
    io_helper.closeFile(try io_helper.createFileAbsolute(dylib, .{}));
    var link_buf: [std.fs.max_path_bytes]u8 = undefined;
    try io_helper.symLink("v14.6.0", try std.fmt.bufPrint(&link_buf, "{s}/packages/harfbuzz.org/v14", .{root}));

    var out: [std.fs.max_path_bytes]u8 = undefined;
    try testing.expectEqualStrings("@rpath/harfbuzz.org/v14/lib/libharfbuzz.dylib", packagesRpathRef(dylib, &out).?);
    // No shorter than what it replaces would need, and nothing outside a packages root.
    try testing.expect(packagesRpathRef("/opt/homebrew/lib/libharfbuzz.dylib", &out) == null);
}

test "a global package loads its own dylib even when its registry rpath reaches the wrong root" {
    if (@import("builtin").os.tag != .macos) return error.SkipZigTest;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];
    const pkg = try std.fmt.allocPrint(a, "{s}/global/packages/example.org/v1.2.3", .{root});
    const lib_dir = try std.fmt.allocPrint(a, "{s}/lib", .{pkg});
    const bin_dir = try std.fmt.allocPrint(a, "{s}/bin", .{pkg});
    try io_helper.makePath(lib_dir);
    try io_helper.makePath(bin_dir);
    const source = try std.fmt.allocPrint(a, "{s}/probe.c", .{root});
    const main_source = try std.fmt.allocPrint(a, "{s}/main.c", .{root});
    const Writer = struct {
        fn write(path: []const u8, text: []const u8) !void {
            const file = try io_helper.createFileAbsolute(path, .{ .truncate = true });
            defer io_helper.closeFile(file);
            try io_helper.writeAllToFile(file, text);
        }
    };
    try Writer.write(source, "int answer(void) { return 42; }\n");
    try Writer.write(main_source, "#include <stdio.h>\nextern int answer(void);\nint main(void) { printf(\"%d\\n\", answer()); return 0; }\n");
    const dylib = try std.fmt.allocPrint(a, "{s}/libprobe.dylib", .{lib_dir});
    const binary = try std.fmt.allocPrint(a, "{s}/probe", .{bin_dir});
    const cc_lib = try io_helper.childRun(a, &.{ "/usr/bin/clang", "-dynamiclib", source, "-Wl,-install_name,@rpath/example.org/v1.2.3/lib/libprobe.dylib", "-o", dylib });
    try std.testing.expect(cc_lib.term == .exited and cc_lib.term.exited == 0);
    const cc_bin = try io_helper.childRun(a, &.{ "/usr/bin/clang", main_source, dylib, "-Wl,-rpath,@loader_path/../../../..", "-o", binary });
    try std.testing.expect(cc_bin.term == .exited and cc_bin.term.exited == 0);
    try fixDirectoryLibraryPaths(a, pkg);
    // Move it too: an absolute rewrite would start here but break after this.
    const moved = try std.fmt.allocPrint(a, "{s}/moved", .{root});
    try io_helper.rename(pkg, moved);
    const moved_binary = try std.fmt.allocPrint(a, "{s}/bin/probe", .{moved});
    const run = try io_helper.childRun(a, &.{moved_binary});
    try std.testing.expect(run.term == .exited and run.term.exited == 0);
    try std.testing.expectEqualStrings("42\n", run.stdout);
}
