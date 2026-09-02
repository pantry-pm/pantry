const std = @import("std");
const io_helper = @import("../io_helper.zig");
const style = @import("../cli/style.zig");
const LinkerMode = @import("../config/pantry_config.zig").LinkerMode;

/// Delegate JS dependency installation to bun/pnpm/yarn/npm when a package.json
/// with JS deps is present alongside pantry's own system-dep file.
///
/// Mirrors `composer_delegate.installPhpDeps` for the JS ecosystem. Pantry
/// installs the runtime (node/bun) via its own pipeline and then hands off to
/// the appropriate JS package manager — it does not try to be a node_modules
/// resolver itself.
///
/// Returns true when delegation actually ran a successful install and false
/// when there was nothing to do. A selected package manager that cannot run or
/// exits unsuccessfully is an install error; callers must not report success
/// with an incomplete node_modules tree.
pub fn installJsDeps(allocator: std.mem.Allocator, project_dir: []const u8, verbose: bool, linker: LinkerMode) !bool {
    const package_json_path = try std.fs.path.join(allocator, &.{ project_dir, "package.json" });
    defer allocator.free(package_json_path);

    const content = io_helper.readFileAlloc(allocator, package_json_path, 4 * 1024 * 1024) catch return false;
    defer allocator.free(content);

    const parsed = std.json.parseFromSlice(std.json.Value, allocator, content, .{}) catch return false;
    defer parsed.deinit();

    if (parsed.value != .object) return false;

    if (!hasJsDeps(parsed.value.object)) return false;

    // Fast no-op: if node_modules/ exists and is newer than package.json and
    // any lockfile, JS deps are already in sync and we can skip without ever
    // spawning the PM. Matches composer_delegate's "vendor + lock" check.
    if (try isUpToDate(allocator, project_dir, package_json_path)) {
        if (verbose) style.print("{s}  JS deps up to date{s}\n", .{ style.dim, style.reset });
        return false;
    }

    const pm = pickPackageManager(project_dir, parsed.value.object);

    const bin_owned = try resolveBin(allocator, project_dir, pm);
    const bin = bin_owned orelse {
        style.printWarn("Cannot install JS dependencies: '{s}' was not found (declare it in Pantry or add it to PATH)\n", .{pm});
        return error.JsPackageManagerNotFound;
    };
    defer allocator.free(bin);

    // Build a sh -c command that prepends <project>/pantry/.bin to PATH so the
    // JS PM can find node and its own helper bins even when the user invoked
    // `pantry install` from a shell where PATH doesn't include pantry/.bin yet.
    // Mirrors the lifecycle.zig PATH-wrapping pattern.
    const wrapped_cmd = try buildWrappedCommand(allocator, project_dir, bin, pm, linker);
    defer allocator.free(wrapped_cmd);

    style.print("{s}  Installing JS deps via {s}{s}\n", .{ style.dim, pm, style.reset });

    // When our stdout carries machine-consumed output (`pantry shell:activate`
    // is eval'd, `pantry env` likewise), the PM child must not inherit it —
    // bun/npm progress lines would corrupt the emitted shell code. Route the
    // child's stdout to stderr alongside our own diagnostics.
    const exec_cmd = if (style.isDiagnosticsToStderr())
        try std.fmt.allocPrint(allocator, "{{ {s} ; }} 1>&2", .{wrapped_cmd})
    else
        try allocator.dupe(u8, wrapped_cmd);
    defer allocator.free(exec_cmd);

    const term = io_helper.spawnAndWait(.{
        .argv = &[_][]const u8{ "sh", "-c", exec_cmd },
        .cwd = io_helper.toCwd(project_dir),
    }) catch |err| {
        style.printWarn("{s} install failed to spawn: {}\n", .{ pm, err });
        return error.JsInstallSpawnFailed;
    };

    switch (term) {
        .exited => |code| {
            if (code != 0) {
                style.printWarn("{s} install exited with code {d}\n", .{ pm, code });
                return error.JsInstallFailed;
            }
        },
        else => {
            style.printWarn("{s} install terminated abnormally\n", .{pm});
            return error.JsInstallFailed;
        },
    }

    writeMarker(allocator, project_dir);
    return true;
}

/// Marker file we write after a successful delegate run. We use it (not the
/// JS PM's own lockfile) for the staleness check because some PMs don't
/// touch the lockfile on a no-op install — that would cause every subsequent
/// `pantry install` after a `touch package.json` to needlessly re-spawn bun.
const marker_relpath = "node_modules/.pantry-js-installed";

/// JS deps considered up-to-date when our marker file exists and its mtime
/// is >= package.json mtime. We can't stat node_modules itself for mtime
/// (io_helper.statFile returns 0 for directories), and we can't trust the
/// JS PM's lockfile because no-op installs don't always touch it.
fn isUpToDate(allocator: std.mem.Allocator, project_dir: []const u8, package_json_path: []const u8) !bool {
    const marker = try std.fs.path.join(allocator, &.{ project_dir, marker_relpath });
    defer allocator.free(marker);

    const marker_stat = io_helper.statFile(marker) catch return false;
    const pkg_stat = io_helper.statFile(package_json_path) catch return false;
    return marker_stat.mtime >= pkg_stat.mtime;
}

fn writeMarker(allocator: std.mem.Allocator, project_dir: []const u8) void {
    const marker = std.fs.path.join(allocator, &.{ project_dir, marker_relpath }) catch return;
    defer allocator.free(marker);
    const file = io_helper.createFile(marker, .{}) catch return;
    defer file.close(io_helper.io);
}

fn hasJsDeps(obj: std.json.ObjectMap) bool {
    const sections = [_][]const u8{ "dependencies", "devDependencies", "optionalDependencies" };
    for (sections) |section| {
        if (obj.get(section)) |val| {
            if (val != .object) continue;
            var it = val.object.iterator();
            while (it.next()) |entry| {
                // Domain-style names (ziglang.org, bun.sh, nodejs.org) are pantry
                // *system* deps, not npm packages — they live in package.json only
                // so one file can express both. They must NOT reach `bun install`:
                // bun tries to npm-resolve `ziglang.org` and 404s. A package.json
                // whose deps are ALL system deps has no real JS work, so we must
                // not spawn a package manager at all. (Same '.'-means-domain rule
                // the rest of pantry uses to route system vs. JS deps.)
                if (std.mem.indexOfScalar(u8, entry.key_ptr.*, '.') == null) return true;
            }
        }
    }
    return false;
}

/// Pick a JS package manager. Priority:
///   1. Lockfile heuristic (most reliable)
///   2. `packageManager` field in package.json
///   3. Default to bun
fn pickPackageManager(project_dir: []const u8, obj: std.json.ObjectMap) []const u8 {
    const lockfile_map = [_]struct { lock: []const u8, pm: []const u8 }{
        .{ .lock = "bun.lock", .pm = "bun" },
        .{ .lock = "bun.lockb", .pm = "bun" },
        .{ .lock = "pnpm-lock.yaml", .pm = "pnpm" },
        .{ .lock = "yarn.lock", .pm = "yarn" },
        .{ .lock = "package-lock.json", .pm = "npm" },
    };
    for (lockfile_map) |entry| {
        var path_buf: [std.fs.max_path_bytes]u8 = undefined;
        const full = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ project_dir, entry.lock }) catch continue;
        io_helper.accessAbsolute(full, .{}) catch continue;
        return entry.pm;
    }

    if (obj.get("packageManager")) |val| {
        if (val == .string) {
            const s = val.string;
            const at_pos = std.mem.indexOfScalar(u8, s, '@') orelse s.len;
            const name = s[0..at_pos];
            const known = [_][]const u8{ "bun", "pnpm", "yarn", "npm" };
            for (known) |k| {
                if (std.mem.eql(u8, name, k)) return k;
            }
        }
    }

    return "bun";
}

/// Resolve the absolute path to a JS package manager binary. Prefers the
/// project's own `pantry/.bin/<name>` (installed by `pantry install`) so we
/// pick up the user-declared version, then falls back to PATH.
fn resolveBin(allocator: std.mem.Allocator, project_dir: []const u8, name: []const u8) !?[]const u8 {
    const local = try std.fs.path.join(allocator, &.{ project_dir, "pantry", ".bin", name });
    if (io_helper.accessAbsolute(local, .{})) |_| {
        return local;
    } else |_| {
        allocator.free(local);
    }

    return io_helper.findExecutable(allocator, name) catch null;
}

/// Build `export PATH='<pantry/.bin>:<old PATH>' && <bin> install` so the child
/// process — and any lifecycle scripts it spawns — can find node/bun without
/// requiring the user to have manually activated pantry's env.
fn buildWrappedCommand(allocator: std.mem.Allocator, project_dir: []const u8, bin: []const u8, pm: []const u8, linker: LinkerMode) ![]u8 {
    const current_path = io_helper.getenv("PATH") orelse "/usr/local/bin:/usr/bin:/bin";

    const path_val = try std.fmt.allocPrint(allocator, "{s}/pantry/.bin:{s}", .{ project_dir, current_path });
    defer allocator.free(path_val);

    var escaped_path = std.ArrayList(u8).empty;
    defer escaped_path.deinit(allocator);
    for (path_val) |ch| {
        if (ch == '\'') {
            try escaped_path.appendSlice(allocator, "'\\''");
        } else {
            try escaped_path.append(allocator, ch);
        }
    }

    if (std.mem.eql(u8, pm, "bun")) {
        return try std.fmt.allocPrint(allocator, "export PATH='{s}' && '{s}' install --linker {s}", .{ escaped_path.items, bin, @tagName(linker) });
    }

    return try std.fmt.allocPrint(allocator, "export PATH='{s}' && '{s}' install", .{ escaped_path.items, bin });
}

test "JS delegate forwards Pantry's linker mode to Bun" {
    const allocator = std.testing.allocator;
    const command = try buildWrappedCommand(allocator, "/tmp/pantry-project", "/usr/bin/bun", "bun", .hoisted);
    defer allocator.free(command);

    try std.testing.expect(std.mem.endsWith(u8, command, "'/usr/bin/bun' install --linker hoisted"));
}

test "JS delegate leaves other package managers' install arguments unchanged" {
    const allocator = std.testing.allocator;
    const command = try buildWrappedCommand(allocator, "/tmp/pantry-project", "/usr/bin/npm", "npm", .isolated);
    defer allocator.free(command);

    try std.testing.expect(std.mem.endsWith(u8, command, "'/usr/bin/npm' install"));
}

test "JS delegate propagates package manager failure without writing marker" {
    if (comptime @import("builtin").os.tag == .windows) return;

    const allocator = std.testing.allocator;
    var tmp_dir = std.testing.tmpDir(.{});
    defer tmp_dir.cleanup();

    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const path_len = try tmp_dir.dir.realPath(io_helper.io, &path_buf);
    const project_dir = path_buf[0..path_len];

    try tmp_dir.dir.writeFile(io_helper.io, .{
        .sub_path = "package.json",
        .data = "{\"dependencies\":{\"left-pad\":\"1.3.0\"}}",
    });
    try tmp_dir.dir.writeFile(io_helper.io, .{
        .sub_path = "package-lock.json",
        .data = "{}",
    });
    try tmp_dir.dir.createDirPath(io_helper.io, "pantry/.bin");
    const fake_npm = try tmp_dir.dir.createFile(io_helper.io, "pantry/.bin/npm", .{});
    try fake_npm.writeStreamingAll(io_helper.io, "#!/bin/sh\nexit 42\n");
    fake_npm.close(io_helper.io);
    const fake_npm_path = try std.fs.path.join(allocator, &.{ project_dir, "pantry/.bin/npm" });
    defer allocator.free(fake_npm_path);
    var chmod_buf: [std.fs.max_path_bytes:0]u8 = undefined;
    @memcpy(chmod_buf[0..fake_npm_path.len], fake_npm_path);
    chmod_buf[fake_npm_path.len] = 0;
    try std.testing.expect(std.c.chmod(&chmod_buf, 0o755) == 0);

    try std.testing.expectError(
        error.JsInstallFailed,
        installJsDeps(allocator, project_dir, false, .hoisted),
    );

    const marker = try std.fs.path.join(allocator, &.{ project_dir, marker_relpath });
    defer allocator.free(marker);
    try std.testing.expectError(error.FileNotFound, io_helper.accessAbsolute(marker, .{}));
}
