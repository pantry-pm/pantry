//! Package executor command - run packages from npm (like npx/bunx)

const std = @import("std");
const io_helper = @import("../../io_helper.zig");
const lib = @import("../../lib.zig");
const common = @import("common.zig");
const style = @import("../style.zig");

const CommandResult = common.CommandResult;

pub const PxOptions = struct {
    use_pantry: bool = false,
    package_name: ?[]const u8 = null,
    silent: bool = false,
    verbose: bool = false,
};

/// An executable name panx resolves to a specific package, instead of to
/// whatever npm happens to publish under that name.
pub const ExecutorAlias = struct {
    executable: []const u8,
    package: []const u8,
};

/// `buddy` is the Stacks CLI, so `panx buddy new my-app` scaffolds a Stacks
/// app. Without this entry it would not: npm's bare `buddy` is an unrelated
/// package, and `@buddysh/buddy` (a CI bot) ships a `buddy` bin too, so the
/// name alone would install and run someone else's code. This is the same
/// decision `install/bin_ownership.zig` makes for `pantry/.bin/buddy`,
/// applied to the executor.
pub const executor_aliases = [_]ExecutorAlias{
    .{ .executable = "buddy", .package = "@stacksjs/buddy" },
};

/// What a panx argument names: the package to install and the binary to run.
pub const Target = struct {
    /// Package name without a version: `@stacksjs/buddy`, `cowsay`.
    package: []const u8,
    /// The version or range asked for (`buddy@0.75.82`), if any.
    version: ?[]const u8,
    /// The binary to execute from that package.
    executable: []const u8,
};

/// Split what the user typed into a package and an executable.
///
/// - an alias (`buddy`, `buddy@0.75`) maps to its package
/// - `@scope/name[@version]` runs the `name` binary, the way npx and bunx do;
///   running a binary literally called `@scope/name` can never succeed
/// - anything else is both the package and the binary
pub fn resolveTarget(spec: []const u8) Target {
    // Split a trailing @version off without mistaking a scope for one.
    var name = spec;
    var version: ?[]const u8 = null;
    const search_from: usize = if (spec.len > 0 and spec[0] == '@') 1 else 0;
    if (std.mem.indexOfScalarPos(u8, spec, search_from, '@')) |at| {
        name = spec[0..at];
        if (at + 1 < spec.len) version = spec[at + 1 ..];
    }

    for (executor_aliases) |alias| {
        if (std.mem.eql(u8, name, alias.executable))
            return .{ .package = alias.package, .version = version, .executable = alias.executable };
    }

    if (name.len > 0 and name[0] == '@') {
        if (std.mem.indexOfScalar(u8, name, '/')) |slash| {
            if (slash + 1 < name.len)
                return .{ .package = name, .version = version, .executable = name[slash + 1 ..] };
        }
    }

    return .{ .package = name, .version = version, .executable = name };
}

/// The directory a package is installed into when nothing local or global
/// provides it: `<cache>/panx/<package>[@<version>]`, with `/` made safe.
/// One per package and version, so runs reuse it and never collide.
fn cacheDirFor(allocator: std.mem.Allocator, target: Target) ![]const u8 {
    const cache_root = try lib.Paths.cache(allocator);
    defer allocator.free(cache_root);

    const key = try allocator.dupe(u8, target.package);
    defer allocator.free(key);
    for (key) |*c| {
        if (c.* == '/') c.* = '+';
    }

    if (target.version) |v|
        return std.fmt.allocPrint(allocator, "{s}/panx/{s}@{s}", .{ cache_root, key, v });
    return std.fmt.allocPrint(allocator, "{s}/panx/{s}", .{ cache_root, key });
}

/// The first existing `<dir>/pantry/.bin/<exe>` or `<dir>/node_modules/.bin/<exe>`.
fn findBinIn(allocator: std.mem.Allocator, dir: []const u8, executable: []const u8) !?[]const u8 {
    const candidates = [_][]const u8{ "pantry", "node_modules" };
    for (candidates) |modules_dir| {
        const path = try std.fs.path.join(allocator, &[_][]const u8{ dir, modules_dir, ".bin", executable });
        if (io_helper.accessAbsolute(path, .{})) |_| {
            return path;
        } else |_| {
            allocator.free(path);
        }
    }
    return null;
}

fn changeDir(path: []const u8) !void {
    var buf: [std.fs.max_path_bytes:0]u8 = undefined;
    if (path.len >= buf.len) return error.NameTooLong;
    @memcpy(buf[0..path.len], path);
    buf[path.len] = 0;
    if (std.c.chdir(&buf) != 0) return error.ChangeDirFailed;
}

/// Install `spec` into its own cache directory rather than into the user's
/// working directory. Before this, panx installed into whatever directory it
/// was run from, so `panx buddy new my-app` in ~/Code left a package.json, a
/// pantry/ and a pantry.lock in ~/Code. The installer resolves its project
/// from the working directory, so it runs with the cache directory as cwd and
/// the original is restored before anything else happens.
fn installIntoCache(allocator: std.mem.Allocator, cache_dir: []const u8, spec: []const u8) !u8 {
    try io_helper.makePath(cache_dir);

    const manifest = try std.fs.path.join(allocator, &[_][]const u8{ cache_dir, "package.json" });
    defer allocator.free(manifest);
    io_helper.accessAbsolute(manifest, .{}) catch {
        const file = try io_helper.createFileAbsolute(manifest, .{});
        defer io_helper.closeFile(file);
        try io_helper.writeAllToFile(file, "{\n  \"name\": \"panx-cache\",\n  \"private\": true\n}\n");
    };

    const original_cwd = try io_helper.getCwdAlloc(allocator);
    defer allocator.free(original_cwd);

    try changeDir(cache_dir);
    defer changeDir(original_cwd) catch {};

    const install = @import("install.zig");
    const install_args = [_][]const u8{spec};
    const result = try install.installCommandWithOptions(allocator, &install_args, install.InstallOptions{});
    defer if (result.message) |msg| allocator.free(msg);
    return result.exit_code;
}

/// Run packages from npm (like npx/bunx)
pub fn pxCommand(allocator: std.mem.Allocator, args: []const []const u8, options: PxOptions) !CommandResult {
    if (args.len == 0) {
        return CommandResult.err(allocator, "Error: No executable specified\nUsage: panx <executable> [args...]");
    }

    // An explicit --package keeps the old contract: install that package, run
    // the executable exactly as typed.
    const target: Target = if (options.package_name) |pkg|
        .{ .package = pkg, .version = null, .executable = args[0] }
    else
        resolveTarget(args[0]);
    const executable_name = target.executable;

    const install_spec = if (target.version) |v|
        try std.fmt.allocPrint(allocator, "{s}@{s}", .{ target.package, v })
    else
        try allocator.dupe(u8, target.package);
    defer allocator.free(install_spec);

    if (!options.silent) {
        style.print("{s}📦 Running package executable{s}\n", .{ style.blue, style.reset });
        style.print("{s}   Package: {s}{s}\n", .{ style.dim, install_spec, style.reset });
        style.print("{s}   Executable: {s}{s}\n\n", .{ style.dim, executable_name, style.reset });
    }

    // Get current working directory, then resolve workspace root
    var cwd_buf: [std.fs.max_path_bytes]u8 = undefined;
    const cwd = try io_helper.realpath(".", &cwd_buf);

    const effective_root = try @import("../../deps/detector.zig").resolveProjectRoot(allocator, cwd);
    defer allocator.free(effective_root);

    // 1. The project's own bin (pantry/.bin, then node_modules/.bin). Inside a
    //    Stacks app this is the app's own buddy, pinned by its lockfile. A
    //    version pin skips it, because the user asked for that version.
    var bin_path: ?[]const u8 = null;
    defer if (bin_path) |p| allocator.free(p);

    if (target.version == null)
        bin_path = try findBinIn(allocator, effective_root, executable_name);

    // 2. A global install, in the bin dir the shell hook puts on PATH. This
    //    used to check ~/.local/share/pantry/bin, which is not where global
    //    installs land (see Paths.globalBinDir), so it never matched.
    if (bin_path == null and target.version == null) {
        const global_bin_dir = try lib.Paths.globalBinDir(allocator);
        defer allocator.free(global_bin_dir);
        const global_bin = try std.fs.path.join(allocator, &[_][]const u8{ global_bin_dir, executable_name });
        if (io_helper.accessAbsolute(global_bin, .{})) |_| {
            bin_path = global_bin;
        } else |_| {
            allocator.free(global_bin);
        }
    }

    // 3. panx's own cache, installing into it if needed.
    if (bin_path == null) {
        const cache_dir = try cacheDirFor(allocator, target);
        defer allocator.free(cache_dir);

        bin_path = try findBinIn(allocator, cache_dir, executable_name);

        if (bin_path == null) {
            if (!options.silent) {
                style.print("{s}📥 Installing {s}...{s}\n\n", .{ style.yellow, install_spec, style.reset });
            }

            const exit_code = try installIntoCache(allocator, cache_dir, install_spec);
            if (exit_code != 0) {
                return .{
                    .exit_code = 1,
                    .message = try std.fmt.allocPrint(allocator, "Error: Failed to install package '{s}'", .{install_spec}),
                };
            }

            bin_path = try findBinIn(allocator, cache_dir, executable_name);
            if (bin_path == null) {
                return .{
                    .exit_code = 1,
                    .message = try std.fmt.allocPrint(allocator, "Error: Package '{s}' installed but has no '{s}' executable", .{ install_spec, executable_name }),
                };
            }
        }
    }

    // Execute with the terminal attached. Collecting stdout and stderr and
    // printing them afterwards broke anything interactive: a scaffolder could
    // not prompt, and a long build showed nothing until it finished.
    var argv = try std.ArrayList([]const u8).initCapacity(allocator, args.len);
    defer argv.deinit(allocator);

    try argv.append(allocator, bin_path.?);
    for (args[1..]) |arg| {
        try argv.append(allocator, arg);
    }

    const term = try io_helper.spawnAndWait(.{ .argv = argv.items });

    const exit_code: u8 = switch (term) {
        .exited => |code| if (code <= 255) @intCast(code) else 1,
        else => 1,
    };

    return .{ .exit_code = exit_code };
}

test "an alias resolves to its package and keeps its binary name" {
    const t = resolveTarget("buddy");
    try std.testing.expectEqualStrings("@stacksjs/buddy", t.package);
    try std.testing.expectEqualStrings("buddy", t.executable);
    try std.testing.expect(t.version == null);
}

test "an alias carries a version through to its package" {
    const t = resolveTarget("buddy@0.75.82");
    try std.testing.expectEqualStrings("@stacksjs/buddy", t.package);
    try std.testing.expectEqualStrings("0.75.82", t.version.?);
    try std.testing.expectEqualStrings("buddy", t.executable);
}

test "a scoped package runs its unscoped binary" {
    const t = resolveTarget("@stacksjs/buddy");
    try std.testing.expectEqualStrings("@stacksjs/buddy", t.package);
    try std.testing.expectEqualStrings("buddy", t.executable);
    try std.testing.expect(t.version == null);
}

test "a scoped package with a version is not mistaken for a scope" {
    const t = resolveTarget("@stacksjs/bumpx@0.3.1");
    try std.testing.expectEqualStrings("@stacksjs/bumpx", t.package);
    try std.testing.expectEqualStrings("0.3.1", t.version.?);
    try std.testing.expectEqualStrings("bumpx", t.executable);
}

test "a plain name is both package and binary" {
    const t = resolveTarget("cowsay@1.6.0");
    try std.testing.expectEqualStrings("cowsay", t.package);
    try std.testing.expectEqualStrings("1.6.0", t.version.?);
    try std.testing.expectEqualStrings("cowsay", t.executable);
}

test "an unaliased name is left alone" {
    const t = resolveTarget("bud");
    try std.testing.expectEqualStrings("bud", t.package);
    try std.testing.expectEqualStrings("bud", t.executable);
}
