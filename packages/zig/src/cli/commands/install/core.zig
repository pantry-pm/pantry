//! Core Install Logic
//!
//! Main installation command implementation for project dependencies.

const std = @import("std");
const native_identity = @import("../../../packages/native_identity.zig");
const native_lock = @import("../../../packages/native_lock.zig");
const io_helper = @import("../../../io_helper.zig");
const lib = @import("../../../lib.zig");
const types = @import("types.zig");
const helpers = @import("helpers.zig");
const env_deps = @import("env_deps.zig");
const workspace = @import("workspace.zig");
const global = @import("global.zig");

const lockfile_hooks = @import("lockfile_hooks.zig");
const offline = @import("../../../install/offline.zig");
const recovery = @import("../../../install/recovery.zig");
const style = @import("../../style.zig");
const dependency_parser = @import("../../../deps/parser.zig");
const scopes = @import("../../../registry/scopes.zig");
const native_deps = @import("../../../install/native_deps.zig");

const cache = lib.cache;
const string = lib.string;
const install = lib.install;

/// Provider identity survives a version/range change. The completed native
/// plan, not discovery, decides which locked version satisfies every edge.
fn hasNativeLockIdentity(original: *const lib.deps.resolution.LockFile, name: []const u8) bool {
    var entries = original.packages.iterator();
    while (entries.next()) |entry| {
        const package = entry.value_ptr.*;
        if (package.source.matches(.pantry) and std.mem.eql(u8, native_identity.canonical(package.name), native_identity.canonical(name))) return true;
    }
    return false;
}

fn shouldInstallWithNativePipeline(delegates_js_dependencies: bool, source: dependency_parser.DependencySource) bool {
    return !delegates_js_dependencies or source == .pantry;
}

fn resolutionLockMatches(
    lock_file: *lib.deps.resolution.LockFile,
    name: []const u8,
    version: []const u8,
    resolved: []const u8,
) bool {
    const locked = lockfile_hooks.getLockedVersionForPackage(lock_file, name) orelse return false;
    return std.mem.eql(u8, locked.version, version) and
        std.mem.eql(u8, locked.resolved, resolved);
}

/// A frozen install may not change a recorded integrity. A lock entry without
/// one (written before integrity was recorded) accepts the first.
fn lockIntegrityMatches(
    lock_file: *lib.deps.resolution.LockFile,
    name: []const u8,
    integrity: ?[]const u8,
) bool {
    const current = integrity orelse return true;
    const locked = lockfile_hooks.getLockedVersionForPackage(lock_file, name) orelse return false;
    const recorded = locked.integrity orelse return true;
    return scopes.integrityEqual(recorded, current);
}

/// `"scopes"` that cannot be honoured stop the install: skipping a malformed
/// pin would let a private scope resolve from npm.
fn scopePinsError(allocator: std.mem.Allocator, err: anyerror, diag: *const scopes.Diagnostic) !types.CommandResult {
    const detail = if (diag.len > 0) diag.message() else @errorName(err);
    return .{
        .exit_code = 1,
        .message = try std.fmt.allocPrint(allocator, "Error: invalid \"scopes\" - {s}", .{detail}),
    };
}

/// Fast path: check if all packages are already installed without doing expensive
/// workspace detection, config loading, hook execution, etc.
/// Returns a CommandResult if everything is up-to-date, null otherwise.
/// Repair the links in the project's `pantry/` (its workspace root's, inside
/// a workspace). Links pantry writes are relative since 0.11.70; this fixes the
/// ones an older pantry left behind, which a skipped package never rewrote.
fn repairProjectTree(allocator: std.mem.Allocator, cwd: []const u8, modules_dir: []const u8) void {
    const detector = @import("../../../deps/detector.zig");
    const tree_repair = @import("../../../install/tree_repair.zig");

    const ws = detector.findWorkspaceFile(allocator, cwd) catch null;
    defer if (ws) |w| {
        allocator.free(w.path);
        allocator.free(w.root_dir);
    };
    const root = if (ws) |w| w.root_dir else cwd;
    const tree = if (std.fs.path.isAbsolute(modules_dir))
        allocator.dupe(u8, modules_dir) catch return
    else
        std.fmt.allocPrint(allocator, "{s}/{s}", .{ root, modules_dir }) catch return;
    defer allocator.free(tree);

    const stats = tree_repair.repairTree(allocator, tree);
    const changed = stats.relinked + stats.retargeted + stats.removed;
    if (changed > 0) {
        style.print("  Repaired {d} link(s) in {s}: {d} made relative, {d} re-pointed, {d} dangling removed\n", .{ changed, modules_dir, stats.relinked, stats.retargeted, stats.removed });
    }
}

fn tryFastUpToDate(allocator: std.mem.Allocator, cwd: []const u8, start_time: i64, modules_dir: []const u8, linker: ?types.LinkerMode, frozen: bool, ignore_scripts: bool) !?types.CommandResult {
    const detector = @import("../../../deps/detector.zig");
    const parser = @import("../../../deps/parser.zig");
    const lockfile_reader = @import("../../../packages/lockfile.zig");

    // 0. Detect workspace context — use workspace root for lockfile/dir checks
    var ws_root_alloc: ?[]const u8 = null;
    defer if (ws_root_alloc) |d| allocator.free(d);
    var ws_path_alloc: ?[]const u8 = null;
    defer if (ws_path_alloc) |p| allocator.free(p);

    const effective_dir = blk: {
        const ws_check = detector.findWorkspaceFile(allocator, cwd) catch null;
        if (ws_check) |ws| {
            ws_path_alloc = ws.path;
            ws_root_alloc = ws.root_dir;
            break :blk ws.root_dir;
        }
        break :blk cwd;
    };
    const is_workspace = ws_root_alloc != null;

    // 1. Find dep file (use effective_dir for lockfile, CWD for dep file discovery)
    const dep_file_names = [_][]const u8{ "pantry.json", "pantry.jsonc", "package.json" };
    var dep_path: ?[]const u8 = null;
    defer if (dep_path) |p| allocator.free(p);

    if (!is_workspace) {
        // Perf: Use stack buffer for fast-path dep file check (avoids 3 allocs)
        var dep_path_buf: [std.fs.max_path_bytes]u8 = undefined;
        for (dep_file_names) |name| {
            const full = std.fmt.bufPrint(&dep_path_buf, "{s}/{s}", .{ cwd, name }) catch continue;
            io_helper.accessAbsolute(full, .{}) catch continue;
            dep_path = try allocator.dupe(u8, full);
            break;
        }
    }

    // 2. Check lockfile exists and read it (at effective_dir for workspaces)
    // Perf: Use stack buffer for lockfile path (avoids heap alloc)
    var lockfile_path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const lockfile_path_stack = std.fmt.bufPrint(&lockfile_path_buf, "{s}/pantry.lock", .{effective_dir}) catch return null;

    var lockfile = lockfile_reader.readLockfile(allocator, lockfile_path_stack) catch return null;
    defer lockfile.deinit(allocator);

    if (lockfile.packages.count() == 0) return null;

    // Workspace manifests and companion deps.yaml files must be compared by
    // declared constraints, not directory counts or mtimes. The workspace
    // installer below performs that authoritative check after parsing every
    // member; bypassing it allowed pulled/checked-out manifests with older
    // mtimes to leave pantry.lock permanently stale.
    if (is_workspace) return null;

    // Non-workspace path: check deps against lockfile
    const found_path = dep_path orelse return null;

    // 3. Parse dep file to get dependency list
    const format = detector.inferFormat(std.fs.path.basename(found_path)) orelse return null;
    const deps_file = detector.DepsFile{ .path = found_path, .format = format };
    const deps = parser.inferDependencies(allocator, deps_file) catch return null;
    defer {
        for (deps) |*dep| {
            var d = dep.*;
            d.deinit(allocator);
        }
        allocator.free(deps);
    }

    if (deps.len == 0) return null;

    // Native identity/frozen/active-edge validation belongs to the shared plan,
    // even when every native program is already present. No metadata is needed
    // for covered pins, so declining this shortcut is not an update request.
    for (deps) |dep| {
        if (helpers.effectiveDependencySource(dep) == .pantry or isProvisionalNpmDependency(dep)) return null;
    }
    const native_env_dependencies = env_deps.infer(allocator, effective_dir, deps, .{}) catch return null;
    defer env_deps.freeDeps(allocator, native_env_dependencies);
    if (native_env_dependencies.len > 0) return null;

    // 4. Check all deps against lockfile + verify dirs exist (O(1) per dep via name set)
    // Perf: For small dep lists, skip HashMap construction and use direct lockfile lookup
    // (HashMap has allocation + hashing overhead; direct lookup is O(1) per dep via StringHashMap.get)
    if (deps.len <= 32) {
        var checked_count: usize = 0;
        for (deps) |dep| {
            if (!helpers.canSkipFromLockfile(&lockfile.packages, dep.name, dep.version, cwd, allocator, modules_dir)) {
                return null;
            }
            checked_count += 1;
        }
        if (checked_count == 0) return null;
    } else {
        var name_set = helpers.buildLockfileNameSet(&lockfile.packages, allocator);
        defer name_set.deinit();
        var constraint_map = helpers.buildConstraintMapFromWorkspaces(&lockfile.workspaces, allocator);
        defer constraint_map.deinit();

        var checked_count: usize = 0;
        for (deps) |dep| {
            if (!helpers.canSkipFromLockfileWithNameSet(&name_set, dep.name, dep.version, &constraint_map, cwd, modules_dir)) {
                return null;
            }
            checked_count += 1;
        }
        if (checked_count == 0) return null;
    }

    // 4a. Services the project's .env names (DB_CONNECTION=pgsql, ...) count
    // as dependencies too, or a changed driver would never be installed.
    //
    // Asked of the disk rather than of the lockfile, because an inference is
    // deliberately absent from the lock (#253). Against the lock this read
    // "not locked, so not up to date" for every inferred service, sending a
    // project with a `.env` down the slow path on every install.
    {
        const inferred = env_deps.infer(allocator, cwd, deps, .{ .report = false }) catch &.{};
        defer env_deps.freeDeps(allocator, inferred);
        for (inferred) |dep| {
            if (!helpers.isPackageInstalled(cwd, modules_dir, dep.name)) return null;
        }
    }

    // 4b. Verify integrity hashes for locked packages (if present)
    // Perf: Use stack buffer for path construction (avoids alloc per package)
    var pkg_it = lockfile.packages.iterator();
    var integrity_path_buf: [std.fs.max_path_bytes]u8 = undefined;
    while (pkg_it.next()) |entry| {
        const pkg = entry.value_ptr.*;
        if (pkg.integrity) |expected_integrity| {
            const pkg_path = std.fmt.bufPrint(&integrity_path_buf, "{s}/{s}/{s}", .{ effective_dir, modules_dir, pkg.name }) catch continue;
            const valid = helpers.verifyPackageIntegrity(allocator, pkg_path, expected_integrity) catch {
                return null; // Integrity verification failed (missing/unreadable) → reinstall
            };
            if (!valid) {
                return null; // Integrity mismatch → fall through to slow path for reinstall
            }
        }
    }

    // 5. All up-to-date!

    // Before declaring victory, give the JS delegate a chance to run if a
    // package.json is present and its mtime indicates JS deps may be stale.
    // Without this, editing package.json (without touching pantry.json) would
    // leave `pantry install` falsely reporting "up to date" while node_modules
    // is stale. The delegate has its own fast no-op check so the common case
    // (nothing changed) stays cheap.
    {
        const js_delegate = @import("../../../deps/js_delegate.zig");
        _ = js_delegate.installJsDepsWithPolicy(allocator, effective_dir, false, linker, frozen, ignore_scripts) catch |err| {
            return .{
                .exit_code = 1,
                .message = try std.fmt.allocPrint(allocator, "JavaScript dependency installation failed: {s}", .{@errorName(err)}),
            };
        };
    }

    helpers.ensureBinSymlinks(allocator, effective_dir, modules_dir);

    const end_ts = io_helper.clockGettime();
    const end_time = @as(i64, @intCast(end_ts.sec)) * 1000 + @as(i64, @intCast(@divFloor(end_ts.nsec, 1_000_000)));
    const elapsed_ms = @as(f64, @floatFromInt(end_time - start_time));
    style.printUpToDate(lockfile.packages.count(), 0, elapsed_ms);
    return .{ .exit_code = 0 };
}

/// Extract the dependency domain from a generated-catalog spec, honoring the
/// `os:` prefix (returns null for other-OS deps) and stripping the version
/// constraint and ` # comment`. e.g. `linux:gnu.org/gcc^14 # note` → `gnu.org/gcc`
/// (on Linux), `apache.org/apr^1` → `apache.org/apr`. Returned slice points into
/// `spec_in` (a static catalog string).
/// A catalog dependency spec split into its parts:
/// `unicode.org^73 # v25` → domain `unicode.org`, constraint `^73`.
const DepSpec = struct { domain: []const u8, constraint: []const u8 };

fn depDomainFromSpec(spec_in: []const u8) ?DepSpec {
    const parsed = native_deps.parsePantryDepSpec(spec_in) orelse return null;
    // Preserve this legacy test adapter's empty spelling for an unversioned
    // edge; active production traversal and guard parsing live in one module.
    return .{ .domain = parsed.domain, .constraint = if (std.mem.indexOfAny(u8, spec_in, "^~<>=@") == null) "" else parsed.version };
}

/// The exit code a manifest install ends on.
///
/// Named rather than inline so the rule has a test, the way
/// `workspaceCommandResult` does for the workspace path. It is one line, and
/// it was the wrong line for long enough to be worth pinning: see the comment
/// at its call site for what a silently-zero install costs a caller.
fn manifestExitCode(failed_count: usize) u8 {
    return if (failed_count > 0) 1 else 0;
}

/// Whether a version string names one version and no other.
///
/// `1.2.0` is exact; `^1.2.0`, `~1.2`, `>=1.2.0`, `1.x`, `*`, `latest` and the
/// empty string are not. The distinction decides how the Pantry registry is
/// asked: an exact version is looked up as that version, a range against the
/// registry's newest (and its version list when that does not satisfy).
fn isExactVersion(version: []const u8) bool {
    if (version.len == 0) return false;
    if (std.mem.eql(u8, version, "latest")) return false;

    // A version starts with a digit; anything else is an operator or a tag.
    if (version[0] < '0' or version[0] > '9') return false;

    for (version) |c| {
        switch (c) {
            '^', '~', '>', '<', '=', '|', ' ', '*', 'x', 'X', ',' => return false,
            else => {},
        }
    }

    return true;
}

fn isProvisionalNpmDependency(dep: dependency_parser.PackageDependency) bool {
    return dep.source == .registry and helpers.effectiveDependencySource(dep) == .npm;
}

fn preferredPipelineVersion(original: *const lib.deps.resolution.LockFile, dep: dependency_parser.PackageDependency) !?[]const u8 {
    if (isProvisionalNpmDependency(dep)) {
        // Auto identity is not yet established. An npm preference cannot use a
        // native/unknown-source record or narrow a later native declaration.
        return lib.deps.resolution.lockfile.lockedVersionSatisfyingFromSource(original, helpers.dependencyName(dep), dep.version, .npm) catch null;
    }
    return helpers.lockedDependencyVersionSatisfying(original, dep);
}

fn pipelineDependency(dep: dependency_parser.PackageDependency, version: []const u8) @import("../../../install/pipeline.zig").PipelineDep {
    return .{
        .name = helpers.dependencyName(dep),
        .version = version,
        .declared_constraint = dep.version,
        .source = helpers.effectiveDependencySource(dep),
        .allow_pantry_fallback = dep.source == .registry,
        .github_owner = if (dep.github_ref) |ref| ref.owner else null,
        .github_repo = if (dep.github_ref) |ref| ref.repo else null,
    };
}

/// Stale wrong-source pins may be repaired normally. A record still owned by
/// an authored JS edge cannot instead be reassigned by a native named add.
fn validateNamedProviderOwnership(allocator: std.mem.Allocator, project_root: []const u8, plan: *const native_deps.Plan) !void {
    var ownership = @import("../../../deps/js_workspace.zig").Ownership.init(allocator);
    defer ownership.deinit();
    try ownership.readExternalProjectDependencies(project_root);
    var names = plan.entries.keyIterator();
    while (names.next()) |name| {
        if (ownership.names.contains(name.*)) return error.NativeSourceConflict;
    }
}

test "parsed explicit npm names reach the real pipeline adapter without native aliasing" {
    const allocator = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.json", .data =
        \\{"dependencies":{"bun":{"version":"^1.4","source":"npm"},"bun.sh":{"version":"1.4.3","source":"pantry"}}}
    });
    const path = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}/pantry.json", .{directory.sub_path});
    defer allocator.free(path);
    const parsed = try dependency_parser.inferDependencies(allocator, .{ .path = path, .format = .pantry_json });
    defer env_deps.freeDeps(allocator, parsed);
    try std.testing.expectEqual(@as(usize, 2), parsed.len);
    for (parsed) |dep| {
        const dispatched = pipelineDependency(dep, "1.4.3");
        if (dep.source == .npm) {
            try std.testing.expectEqualStrings("npm:bun", dep.name);
            try std.testing.expectEqualStrings("bun", dispatched.name);
            try std.testing.expectEqual(lib.packages.PackageSource.npm, dispatched.source);
            try std.testing.expectEqualStrings("^1.4", dispatched.declared_constraint.?);
            try std.testing.expect(!dispatched.allow_pantry_fallback);
        } else {
            try std.testing.expectEqualStrings("bun.com", dispatched.name);
            try std.testing.expectEqual(lib.packages.PackageSource.pantry, dispatched.source);
        }
    }
    var original = try lib.deps.resolution.LockFile.parse(allocator,
        \\{"packages":{"npm":{"name":"bun","version":"1.4.3","source":"npm"},"native":{"name":"bun.sh","version":"1.4.4","source":"pantry"}}}
    );
    defer original.deinit();
    try std.testing.expectEqualStrings("1.4.3", (try helpers.lockedDependencyVersionSatisfying(&original, .{ .name = "npm:bun", .version = "^1", .source = .npm })).?);
}

test "named native additions protect active JS owners while permitting stale provenance repair" {
    const allocator = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const cwd = try io_helper.getCwdAlloc(allocator);
    defer allocator.free(cwd);
    const root = try std.fs.path.join(allocator, &.{ cwd, ".zig-cache", "tmp", directory.sub_path[0..] });
    defer allocator.free(root);
    var plan = native_deps.Plan.init(allocator);
    defer plan.deinit();
    try plan.add("bun.sh", "1.4.3");
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data =
        \\{"name":"fixture","dependencies":{"bun.com":"1.4.3"}}
    });
    try std.testing.expectError(error.NativeSourceConflict, validateNamedProviderOwnership(allocator, root, &plan));
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data =
        \\{"name":"fixture","dependencies":{}}
    });
    try validateNamedProviderOwnership(allocator, root, &plan);
    try directory.dir.createDirPath(io_helper.io, "packages/local");
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data =
        \\{"name":"fixture","workspaces":["packages/*"]}
    });
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "packages/local/package.json", .data =
        \\{"name":"@fixture/local","version":"1.0.0","dependencies":{"bun.com":"1.4.3"}}
    });
    try std.testing.expectError(error.NativeSourceConflict, validateNamedProviderOwnership(allocator, root, &plan));
    // A member name alone cannot hide a remotely satisfied dependency.
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "packages/local/package.json", .data =
        \\{"name":"bun.com","version":"1.0.0"}
    });
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data =
        \\{"name":"fixture","workspaces":["packages/*"],"dependencies":{"bun.com":"^2"}}
    });
    try std.testing.expectError(error.NativeSourceConflict, validateNamedProviderOwnership(allocator, root, &plan));
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data =
        \\{"name":"fixture","workspaces":["packages/*"],"dependencies":{"bun.com":"^1"}}
    });
    try validateNamedProviderOwnership(allocator, root, &plan);
    // Explicit companion providers keep their literal identity even without a
    // lockfile, including the empty preference view used by --force.
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.json", .data =
        \\{"dependencies":{"bun.com":{"version":"^2","source":"npm"}}}
    });
    try std.testing.expectError(error.NativeSourceConflict, validateNamedProviderOwnership(allocator, root, &plan));
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.json", .data =
        \\{"dependencies":{}}
    });
    try validateNamedProviderOwnership(allocator, root, &plan);
    try std.testing.expectError(error.FileNotFound, directory.dir.access(io_helper.io, "pantry", .{}));
}

test "named provider ownership uses catalogs, Pantry workspaces and JSONC declarations" {
    const allocator = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const root = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}", .{directory.sub_path});
    defer allocator.free(root);
    var plan = native_deps.Plan.init(allocator);
    defer plan.deinit();
    try plan.add("bun.sh", "1.4.3");
    try directory.dir.createDirPath(io_helper.io, "packages/local");
    try directory.dir.createDirPath(io_helper.io, "packages/consumer");
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "packages/local/package.json", .data =
        \\{"name":"bun.com","version":"1.0.0"}
    });
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "packages/consumer/package.json", .data =
        \\{"name":"consumer","dependencies":{"bun.com":"catalog:"}}
    });
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data =
        \\{"workspaces":["packages/*"],"catalog":{"bun.com":"^1"},"catalogs":{"remote":{"bun.com":"^2"}}}
    });
    try validateNamedProviderOwnership(allocator, root, &plan);
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "packages/consumer/package.json", .data =
        \\{"name":"consumer","dependencies":{"bun.com":"catalog:remote"}}
    });
    try std.testing.expectError(error.NativeSourceConflict, validateNamedProviderOwnership(allocator, root, &plan));
    // Member discovery follows the actual Pantry workspace even when package.json
    // contains no workspaces field.
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data = "{}" });
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.json", .data =
        \\{"workspaces":["packages/*"]}
    });
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "packages/consumer/package.json", .data =
        \\{"name":"consumer","dependencies":{"bun.com":"^2"}}
    });
    try std.testing.expectError(error.NativeSourceConflict, validateNamedProviderOwnership(allocator, root, &plan));
    try directory.dir.deleteFile(io_helper.io, "pantry.json");
    try directory.dir.deleteFile(io_helper.io, "package.json");
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "package.jsonc", .data =
        \\{/* authored npm dependency */ "dependencies":{"bun.com":"^2",},}
    });
    try std.testing.expectError(error.NativeSourceConflict, validateNamedProviderOwnership(allocator, root, &plan));
    try std.testing.expectError(error.FileNotFound, directory.dir.access(io_helper.io, "pantry", .{}));
}

test "member discovery retains recognized nested dependency configs" {
    const allocator = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const root = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}", .{directory.sub_path});
    defer allocator.free(root);
    try directory.dir.createDirPath(io_helper.io, "packages/typed/config");
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data =
        \\{"workspaces":["packages/*"]}
    });
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "packages/typed/config/deps.ts", .data =
        \\export default { dependencies: { 'bun.com': { version: '^2', source: 'npm' } } }
    });
    const manifest = try std.fs.path.join(allocator, &.{ root, "package.json" });
    defer allocator.free(manifest);
    var config = try @import("../../../packages/workspace.zig").loadWorkspaceConfig(allocator, manifest, root);
    defer config.deinit(allocator);
    try std.testing.expectEqual(@as(usize, 1), config.members.len);
    try std.testing.expect(std.mem.endsWith(u8, config.members[0].deps_file_path.?, "config/deps.ts"));
}

test "evaluated native config declarations retain dispatch and environment ownership" {
    const allocator = std.testing.allocator;
    const declarations = try dependency_parser.parseEvaluatedDependencyJson(allocator,
        \\{"dependencies":{"postgres":{"version":"17"},"redis":"7","npmredis":{"version":"7","source":"npm"}}}
    );
    defer env_deps.freeDeps(allocator, declarations);
    try std.testing.expectEqual(@as(usize, 3), declarations.len);
    try std.testing.expectEqualStrings("postgres", declarations[0].name);
    try std.testing.expectEqualStrings("postgresql.org", pipelineDependency(declarations[0], "17").name);
    try std.testing.expectEqual(lib.packages.PackageSource.pantry, pipelineDependency(declarations[0], "17").source);
    try std.testing.expect(env_deps.isDeclared(declarations, "postgresql.org"));
    try std.testing.expect(env_deps.isDeclared(declarations, "redis.io"));
    const inferred = [_]dependency_parser.PackageDependency{
        .{ .name = "postgresql.org", .version = "latest", .source = .pantry },
        .{ .name = "redis.io", .version = "latest", .source = .pantry },
    };
    var env_only = try env_deps.inferredOnlyDomains(allocator, &inferred, declarations);
    defer env_only.deinit();
    try std.testing.expect(!env_only.contains("postgresql.org"));
    try std.testing.expect(!env_only.contains("redis.io"));
    try std.testing.expect(!env_deps.isDeclared(&.{.{ .name = "auto:redis", .version = "7", .source = .registry }}, "redis.io"));
}

const NamedInstallRequest = struct {
    spec: lib.packages.PackageSpec,
    declared_constraint: []const u8,
    direct: bool,
    integrity: ?[]const u8 = null,

    fn init(allocator: std.mem.Allocator, input: lib.packages.PackageSpec, declared: []const u8, direct: bool, integrity: ?[]const u8) !NamedInstallRequest {
        var spec = lib.packages.PackageSpec{ .name = try allocator.dupe(u8, input.name), .version = input.version, .source = input.source };
        errdefer allocator.free(spec.name);
        spec.version = try allocator.dupe(u8, input.version);
        errdefer allocator.free(spec.version);
        spec.url = if (input.url) |url| try allocator.dupe(u8, url) else null;
        errdefer if (spec.url) |url| allocator.free(url);
        const constraint = try allocator.dupe(u8, declared);
        errdefer allocator.free(constraint);
        return .{ .spec = spec, .declared_constraint = constraint, .direct = direct, .integrity = if (integrity) |value| try allocator.dupe(u8, value) else null };
    }

    fn deinit(self: *NamedInstallRequest, allocator: std.mem.Allocator) void {
        self.spec.deinit(allocator);
        allocator.free(self.declared_constraint);
        if (self.integrity) |integrity| allocator.free(integrity);
    }
};

fn appendNamedRequest(allocator: std.mem.Allocator, requests: *std.ArrayList(NamedInstallRequest), spec: lib.packages.PackageSpec, declared: []const u8, direct: bool, integrity: ?[]const u8) !void {
    var owned = try NamedInstallRequest.init(allocator, spec, declared, direct, integrity);
    errdefer owned.deinit(allocator);
    try requests.append(allocator, owned);
}

fn collectNamedNativePlan(allocator: std.mem.Allocator, requests: []const NamedInstallRequest) !native_deps.Plan {
    var plan = native_deps.Plan.init(allocator);
    errdefer plan.deinit();
    for (requests) |request| {
        if (request.spec.source == .pantry) try plan.add(request.spec.name, request.declared_constraint);
    }
    try plan.expand();
    for (requests) |request| {
        if (request.spec.source != .pantry and plan.entries.contains(request.spec.name)) return error.NativeSourceConflict;
    }
    return plan;
}

/// Install packages - main entry point
pub fn installCommand(allocator: std.mem.Allocator, args: []const []const u8) !types.CommandResult {
    return installCommandWithOptions(allocator, args, .{});
}

fn previewInstall(allocator: std.mem.Allocator, package_args: []const []const u8) !types.CommandResult {
    style.print("Dry run: no changes will be made.\n", .{});

    if (package_args.len > 0) {
        for (package_args) |package| {
            style.print("  Would install {s}\n", .{package});
        }
        return .{ .exit_code = 0 };
    }

    const detector = @import("../../../deps/detector.zig");
    const cwd = try io_helper.getCwdAlloc(allocator);
    defer allocator.free(cwd);

    const lookup = try detector.findDepsAndWorkspaceFile(allocator, cwd);
    defer {
        if (lookup.deps_file) |deps_file| allocator.free(deps_file.path);
        if (lookup.workspace_file) |workspace_file| {
            allocator.free(workspace_file.path);
            allocator.free(workspace_file.root_dir);
        }
    }

    var found = false;
    if (lookup.workspace_file) |workspace_file| {
        style.print("  Would install workspace dependencies from {s}\n", .{workspace_file.path});
        found = true;
    }
    if (lookup.deps_file) |deps_file| {
        if (lookup.workspace_file == null or !std.mem.eql(u8, deps_file.path, lookup.workspace_file.?.path)) {
            style.print("  Would install project dependencies from {s}\n", .{deps_file.path});
        }
        found = true;
    }

    if (!found) {
        return .{
            .exit_code = 1,
            .message = try allocator.dupe(u8, "No dependency manifest found"),
        };
    }

    return .{ .exit_code = 0 };
}

/// Install packages with options
pub fn installCommandWithOptions(allocator: std.mem.Allocator, args: []const []const u8, initial_options: types.InstallOptions) !types.CommandResult {
    // Parse flags and filter out non-package arguments
    var is_global = false;
    var options = initial_options;
    var package_args = try std.ArrayList([]const u8).initCapacity(allocator, args.len);
    defer package_args.deinit(allocator);

    for (args) |arg| {
        if (std.mem.eql(u8, arg, "-g") or std.mem.eql(u8, arg, "--global")) {
            is_global = true;
        } else if (std.mem.eql(u8, arg, "--force") or std.mem.eql(u8, arg, "-f")) {
            options.force = true;
        } else if (std.mem.eql(u8, arg, "--frozen-lockfile")) {
            options.frozen_lockfile = true;
        } else if (std.mem.eql(u8, arg, "--ignore-scripts")) {
            options.ignore_scripts = true;
        } else if (std.mem.eql(u8, arg, "--no-cache")) {
            options.no_cache = true;
        } else if (std.mem.eql(u8, arg, "--no-save")) {
            options.no_save = true;
        } else if (std.mem.eql(u8, arg, "--dry-run")) {
            options.dry_run = true;
        } else if (std.mem.eql(u8, arg, "--no-auto-link")) {
            options.auto_link = false;
        } else if (std.mem.eql(u8, arg, "--quiet") or std.mem.eql(u8, arg, "-q")) {
            options.quiet = true;
        } else if (!std.mem.startsWith(u8, arg, "-")) {
            try package_args.append(allocator, arg);
        }
    }

    // Honor quiet mode for all downstream output: progress, per-package lines,
    // summaries and headers are suppressed; errors/failures still surface via
    // style.printForced. shell:activate / `pantry env` pass quiet=true so that
    // `eval "$(pantry env)"` never tries to execute progress chatter.
    // PANTRY_QUIET=1 forces quiet for every entry point (install/add/ci and the
    // auto-install triggered on `cd`) without needing a flag each time.
    if (io_helper.getEnvVarOwned(allocator, "PANTRY_QUIET")) |val| {
        defer allocator.free(val);
        if (std.mem.eql(u8, val, "1") or std.mem.eql(u8, val, "true")) options.quiet = true;
    } else |_| {}
    style.setQuiet(options.quiet);

    // Header (bun-style): "pantry install v0.10.3 (hash)" once at the top of
    // every install — including the auto-install fired on `cd`. print() is
    // quiet-aware, so `pantry env`/shell:activate (quiet=true) emit nothing.
    const build_version = @import("version");
    style.printHeader("install", build_version.version, build_version.commit_hash);

    if (options.dry_run) {
        return previewInstall(allocator, package_args.items);
    }

    // If -g flag is set with no packages, scan for global dependencies
    if (is_global and package_args.items.len == 0) {
        return try global.installGlobalDepsCommand(allocator);
    }

    // If -g flag is set with packages, install those packages globally
    if (is_global and package_args.items.len > 0) {
        return try global.installPackagesGloballyCommand(allocator, package_args.items);
    }

    // Otherwise, normal install flow
    if (package_args.items.len == 0) {
        // No args - check if we're in a project directory
        const detector = @import("../../../deps/detector.zig");
        const parser = @import("../../../deps/parser.zig");

        const cwd = try io_helper.getCwdAlloc(allocator);
        defer allocator.free(cwd);
        // Whatever path the install takes, up-to-date included, leave the
        // tree's links relative and none of them dangling (see tree_repair).
        defer repairProjectTree(allocator, cwd, options.modules_dir);

        // Start timing for install operation (millisecond precision)
        const start_ts = io_helper.clockGettime();
        const start_time = @as(i64, @intCast(start_ts.sec)) * 1000 + @as(i64, @intCast(@divFloor(start_ts.nsec, 1_000_000)));

        // ── FAST PATH: check if everything is already up-to-date ──
        // This avoids expensive workspace detection, config loading, hooks, etc.
        // Skipped when --force is set (user wants to re-download everything)
        if (!options.force) {
            if (try tryFastUpToDate(allocator, cwd, start_time, options.modules_dir, options.linker, options.frozen_lockfile, options.ignore_scripts)) |result| {
                return result;
            }
        }

        // Combined lookup: find both deps file and workspace file in a single directory walk
        // (avoids two separate realpath + directory traversals)
        var lookup = try detector.findDepsAndWorkspaceFile(allocator, cwd);
        defer {
            if (lookup.deps_file) |file| allocator.free(file.path);
            if (lookup.workspace_file) |file| {
                allocator.free(file.path);
                allocator.free(file.root_dir);
            }
        }

        // If we're in a workspace, handle that first
        if (lookup.workspace_file) |ws_file| {
            const has_companion_deps = if (lookup.deps_file) |df|
                !std.mem.eql(u8, df.path, ws_file.path)
            else
                false;
            var staged_lockfile_path: ?[]const u8 = null;
            defer if (staged_lockfile_path) |path| {
                io_helper.deleteFile(path) catch {};
                allocator.free(path);
            };

            var original_native_lock: ?lib.deps.resolution.LockFile = if (has_companion_deps)
                if (options.force and !options.frozen_lockfile) lib.deps.resolution.LockFile.init(allocator) else try lockfile_hooks.loadOrCreateLockfile(allocator, ws_file.root_dir)
            else
                null;
            defer if (original_native_lock) |*original| original.deinit();
            var native_session: ?native_deps.Session = if (original_native_lock) |*original|
                native_deps.Session.init(allocator, original, options.frozen_lockfile, options.force)
            else
                null;
            defer if (native_session) |*session| session.deinit();
            const companion_declarations = if (has_companion_deps)
                parser.inferDependencies(allocator, lookup.deps_file.?) catch |err| {
                    var failure = types.CommandResult{ .exit_code = 0 };
                    try mergeCompanionResult(allocator, &failure, err, lookup.deps_file.?.path);
                    return failure;
                }
            else
                null;
            defer if (companion_declarations) |declared| env_deps.freeDeps(allocator, declared);
            const companion_inferred = if (companion_declarations) |declared|
                env_deps.infer(allocator, ws_file.root_dir, declared, .{}) catch &.{}
            else
                null;
            defer if (companion_inferred) |inferred| env_deps.freeDeps(allocator, inferred);
            const supplemental = if (companion_declarations) |declared| blk: {
                const inferred = companion_inferred orelse &.{};
                const roots = try allocator.alloc(native_deps.Root, declared.len + inferred.len);
                for (declared, 0..) |dep, index| roots[index] = .{
                    .name = helpers.dependencyName(dep),
                    .version = dep.version,
                    .source = helpers.effectiveDependencySource(dep),
                    .allow_pantry_fallback = dep.source == .registry,
                    .github_owner = if (dep.github_ref) |ref| ref.owner else null,
                    .github_repo = if (dep.github_ref) |ref| ref.repo else null,
                };
                for (inferred, 0..) |dep, index| roots[declared.len + index] = .{ .name = helpers.dependencyName(dep), .version = dep.version, .source = helpers.effectiveDependencySource(dep), .allow_pantry_fallback = dep.source == .registry };
                break :blk roots;
            } else null;
            defer if (supplemental) |roots| allocator.free(roots);
            if (native_session) |*session| session.supplemental_roots = supplemental orelse &.{};

            var workspace_options = options;
            if (native_session) |*session| workspace_options.native_session = session;
            workspace_options.companion_declarations = companion_declarations;
            workspace_options.companion_inferred = companion_inferred;
            // Bun/Node/PHP may be declared only in the companion deps file.
            // Finish the ecosystem install once those runtimes are installed,
            // without requiring an already configured host PATH or a retry.
            workspace_options.defer_ecosystem_install = has_companion_deps;
            // The committed lock must describe the complete install. Stage both
            // phases even without --frozen-lockfile, so a companion failure or
            // interruption cannot replace it with an npm-only workspace lock.
            if (has_companion_deps and (options.frozen_lockfile or !options.no_save)) {
                const lockfile_nonce = io_helper.clockGettime();
                staged_lockfile_path = try std.fmt.allocPrint(
                    allocator,
                    "{s}/.pantry.lock.{d}-{d}.tmp",
                    .{ ws_file.root_dir, lockfile_nonce.sec, lockfile_nonce.nsec },
                );
                workspace_options.lockfile_output_path = staged_lockfile_path;
            }

            const ws_result = workspace.installWorkspaceCommandWithOptions(allocator, ws_file.root_dir, ws_file.path, workspace_options);
            if (ws_result) |result| {
                var final_result = result;

                // Monorepos often keep system/runtime deps in deps.yaml (or pantry.json)
                // alongside package.json workspaces. Install that companion file too.
                if (lookup.deps_file) |df| {
                    if (final_result.exit_code == 0 and !std.mem.eql(u8, df.path, ws_file.path)) {
                        try mergeCompanionResult(allocator, &final_result, installCompanionDepsFile(
                            allocator,
                            df,
                            ws_file.root_dir,
                            workspace_options,
                            staged_lockfile_path,
                        ), df.path);
                    }
                }

                if (has_companion_deps and final_result.exit_code == 0) {
                    if (try workspace.completeEcosystemInstall(allocator, ws_file.root_dir, options)) |failure| {
                        final_result.deinit(allocator);
                        final_result = failure;
                    }
                }

                if (staged_lockfile_path) |generated_path| {
                    try finalizeCombinedWorkspaceLock(allocator, ws_file.root_dir, generated_path, options.frozen_lockfile, &final_result);
                }

                return final_result;
            } else |err| {
                // Workspace config couldn't be loaded (e.g. no valid workspaces patterns,
                // JSON parse error, or "workspaces" was just a substring match).
                // Fall through to normal dep handling.
                if (err != error.NoWorkspacePatternsFound) return err;
            }
        }

        // Try standard dep file detection first (fast: just filesystem access checks)
        // Only fall back to config loading (slow: may spawn Bun/Node) if no dep file found
        var deps: []parser.PackageDependency = undefined;
        var deps_file_path: ?[]const u8 = null;
        var used_config = false;
        var delegates_js_dependencies = false;
        defer if (deps_file_path) |path| allocator.free(path);

        if (lookup.deps_file) |deps_file| {
            if (parser.inferDependencies(allocator, deps_file)) |parsed_deps| {
                deps_file_path = deps_file.path;
                lookup.deps_file = null; // Transfer to deps_file_path's defer.
                deps = parsed_deps;
                delegates_js_dependencies = deps_file.format == .package_json or deps_file.format == .package_jsonc;
            } else |err| {
                if (err == error.NoRuntimeAvailable) {
                    // TS config file detected but no bun/node runtime available — exit silently.
                    return .{ .exit_code = 0, .message = null };
                }
                return err;
            }
        } else {
            // No standard dep file, try config file (pantry.config.ts, etc.)
            const config_deps = try helpers.loadDependenciesFromConfig(allocator, cwd);
            if (config_deps) |config_dep_list| {
                deps = config_dep_list;
                used_config = true;
            } else {
                return .{
                    .exit_code = 1,
                    .message = try allocator.dupe(u8, "Error: No packages specified and no dependency file found"),
                };
            }
        }

        defer {
            for (deps) |*dep| {
                var d = dep.*;
                d.deinit(allocator);
            }
            // Only free deps if we allocated it (not if it came from config)
            if (!used_config) {
                allocator.free(deps);
            }
        }

        // Install GUI apps & fonts declared in deps.yaml (macOS). Runs before the
        // dependency filter so it still fires when a project declares only
        // apps:/fonts: and no command-line dependencies. No-op off macOS; every
        // failure is non-fatal so it never breaks the CLI-dependency install.
        if (deps_file_path) |dpath| {
            const desktop_apps = @import("../../../install/desktop_apps.zig");
            desktop_apps.installFromDepsFile(allocator, dpath, options.quiet);
        }

        // Filter dependencies based on options
        var filtered_deps = try std.ArrayList(parser.PackageDependency).initCapacity(allocator, deps.len);
        defer filtered_deps.deinit(allocator);

        for (deps) |dep| {
            const should_include = blk: {
                if (options.dev_only) {
                    // --dev: only install devDependencies
                    break :blk dep.dep_type == .dev;
                } else if (options.production) {
                    // --production: install only dependencies (skip dev and peer unless --peer is set)
                    if (dep.dep_type == .dev) {
                        break :blk false;
                    } else if (dep.dep_type == .peer) {
                        break :blk options.include_peer;
                    } else {
                        break :blk true; // .normal dependencies
                    }
                } else {
                    // Default: install dependencies and devDependencies
                    // Peer deps only if explicitly enabled via pantry.toml or --peer flag
                    if (dep.dep_type == .peer) {
                        break :blk options.include_peer;
                    }
                    break :blk true;
                }
            };

            if (should_include) {
                // Skip marker deps — these are handled by post-install delegation
                if (std.mem.startsWith(u8, dep.name, "__") and std.mem.endsWith(u8, dep.name, "__")) {
                    continue;
                }
                // A conventional package.json belongs to its selected JS package
                // manager. Installing those entries into pantry/ and then invoking
                // bun/pnpm/yarn/npm duplicated the full dependency graph and made
                // clean installs unnecessarily slow. Explicit Pantry dependencies
                // (`pantry` / `system` fields) retain source=.pantry and still flow
                // through the native pipeline before JS delegation runs once.
                if (!shouldInstallWithNativePipeline(delegates_js_dependencies, dep.source)) {
                    continue;
                }
                try filtered_deps.append(allocator, dep);
            }
        }

        // Services the project's .env names (DB_CONNECTION=pgsql -> postgresql.org,
        // ...), unless the dependency file already declares them (#36).
        const env_inferred = env_deps.infer(
            allocator,
            if (deps_file_path) |path| std.fs.path.dirname(path) orelse cwd else cwd,
            deps,
            .{},
        ) catch &.{};
        defer env_deps.freeDeps(allocator, env_inferred);
        try filtered_deps.appendSlice(allocator, env_inferred);

        // They are installed, and that is all they are. `pantry.lock` records
        // what the workspace declares, so neither these nor what they pull in
        // may reach it — a lock refreshed on a machine whose `.env` says
        // postgres otherwise carries three entries a checkout without that
        // `.env` removes again (#253).
        var env_only_domains = env_deps.inferredOnlyDomains(allocator, env_inferred, deps) catch
            env_deps.DomainSet{ .allocator = allocator, .map = std.StringHashMap(void).init(allocator) };
        defer env_only_domains.deinit();

        // Load overrides/resolutions from package.json if it exists
        var override_map = lib.deps.overrides.OverrideMap.init(allocator);
        defer override_map.deinit();

        const package_json_path = try std.fs.path.join(allocator, &[_][]const u8{ cwd, "package.json" });
        defer allocator.free(package_json_path);

        if (io_helper.readFileAlloc(allocator, package_json_path, 1024 * 1024)) |package_json_content| {
            defer allocator.free(package_json_content);

            if (std.json.parseFromSlice(std.json.Value, allocator, package_json_content, .{})) |parsed| {
                defer parsed.deinit();
                override_map = try lib.deps.overrides.parseFromPackageJson(allocator, parsed);

                if (override_map.count() > 0) {
                    style.print("Found {d} package override(s)\n", .{override_map.count()});
                }
            } else |_| {
                // Failed to parse package.json, continue without overrides
            }
        } else |_| {
            // No package.json or failed to read, continue without overrides
        }

        // Apply overrides to dependencies
        for (filtered_deps.items) |*dep| {
            if (lib.deps.overrides.shouldOverride(&override_map, dep.name)) |override_version| {
                // Allocate new version first to prevent double-free if alloc fails
                const new_version = try allocator.dupe(u8, override_version);
                allocator.free(dep.version);
                dep.version = new_version;
            }
        }

        // Use filtered_deps from this point forward
        const deps_to_install = filtered_deps.items;

        if (deps_to_install.len == 0) {
            // Even with zero npm/system deps, check for PHP deps (composer.json)
            // and Zig deps (build.zig.zon) that need post-install handling
            const proj_dir_early = if (deps_file_path) |path|
                std.fs.path.dirname(path) orelse cwd
            else
                cwd;

            // Run Composer delegate for PHP deps
            {
                const composer_delegate = @import("../../../deps/composer_delegate.zig");
                const php_installed = composer_delegate.installPhpDeps(allocator, proj_dir_early, options.verbose) catch false;
                if (php_installed) {
                    const end_ts = io_helper.clockGettime();
                    const end_time = @as(i64, @intCast(end_ts.sec)) * 1000 + @as(i64, @intCast(@divFloor(end_ts.nsec, 1_000_000)));
                    const elapsed_ms = @as(f64, @floatFromInt(end_time - start_time));
                    style.printSummary(0, 0, elapsed_ms);
                    return .{ .exit_code = 0 };
                }
            }

            // Run JS delegate for package.json deps
            {
                const js_delegate = @import("../../../deps/js_delegate.zig");
                const js_installed = js_delegate.installJsDepsWithPolicy(allocator, proj_dir_early, options.verbose, options.linker, options.frozen_lockfile, options.ignore_scripts) catch |err| {
                    return .{
                        .exit_code = 1,
                        .message = try std.fmt.allocPrint(allocator, "JavaScript dependency installation failed: {s}", .{@errorName(err)}),
                    };
                };
                if (js_installed) {
                    const end_ts = io_helper.clockGettime();
                    const end_time = @as(i64, @intCast(end_ts.sec)) * 1000 + @as(i64, @intCast(@divFloor(end_ts.nsec, 1_000_000)));
                    const elapsed_ms = @as(f64, @floatFromInt(end_time - start_time));
                    style.printSummary(0, 0, elapsed_ms);
                    return .{ .exit_code = 0 };
                }
            }

            // Sync build.zig.zon for Zig deps
            {
                const zig_zon_sync = @import("../../../deps/zig_zon_sync.zig");
                zig_zon_sync.syncBuildZigZon(allocator, proj_dir_early, options.modules_dir, options.verbose) catch {};
            }

            if (deps_file_path) |path| {
                style.print("No dependencies to install from {s}\n", .{path});
            } else {
                style.print("No dependencies to install from config file\n", .{});
            }
            return .{ .exit_code = 0 };
        }

        // Create project-specific environment
        const proj_dir = if (deps_file_path) |path|
            std.fs.path.dirname(path) orelse cwd
        else
            cwd;
        const proj_basename = std.fs.path.basename(proj_dir);

        // Hash project directory for short hash
        var proj_hasher = std.crypto.hash.Md5.init(.{});
        proj_hasher.update(proj_dir);
        var proj_hash: [16]u8 = undefined;
        proj_hasher.final(&proj_hash);
        const proj_hash_short = try std.fmt.allocPrint(allocator, "{x:0>8}", .{std.mem.readInt(u32, proj_hash[0..4], .little)});
        defer allocator.free(proj_hash_short);

        // Hash dependency file path (or project dir if using config)
        // Uses path instead of file contents to avoid re-reading the dep file
        const hash_input = if (deps_file_path) |path|
            path
        else
            proj_dir;

        var dep_hasher = std.crypto.hash.Md5.init(.{});
        dep_hasher.update(hash_input);
        var dep_hash: [16]u8 = undefined;
        dep_hasher.final(&dep_hash);
        const dep_hash_hex = try string.hashToHex(dep_hash, allocator);
        defer allocator.free(dep_hash_hex);
        const dep_hash_short = try std.fmt.allocPrint(allocator, "d{s}", .{dep_hash_hex[0..8]});
        defer allocator.free(dep_hash_short);

        // Create environment directory under the pantry data dir (same layout as shell integration)
        const data_dir = try lib.Paths.data(allocator);
        defer allocator.free(data_dir);

        const env_name = try std.fmt.allocPrint(
            allocator,
            "{s}_{s}-{s}",
            .{ proj_basename, proj_hash_short, dep_hash_short },
        );
        defer allocator.free(env_name);

        const env_dir = try std.fs.path.join(allocator, &[_][]const u8{ data_dir, "envs", env_name });
        defer allocator.free(env_dir);

        // Create environment directory structure
        try io_helper.makePath(env_dir);
        const bin_dir = try std.fmt.allocPrint(allocator, "{s}/bin", .{env_dir});
        defer allocator.free(bin_dir);
        try io_helper.makePath(bin_dir);

        // Check if we're in offline mode
        const is_offline = offline.isOfflineMode();
        if (is_offline) {
            style.printOffline();
        }

        // Show force mode indicator
        if (options.force) {
            style.print("{s}Force mode:{s} ignoring cache and lockfile\n", .{ style.yellow, style.reset });
        }

        // Try to resume from a previous interrupted install, or create a fresh checkpoint
        var checkpoint = recovery.InstallCheckpoint.loadFromDisk(allocator, proj_dir) catch null orelse recovery.InstallCheckpoint.init(allocator);
        defer checkpoint.deinit();

        const resuming_count: usize = checkpoint.installed_packages.count();

        // Set checkpoint path for persistence (enables resume on interrupt)
        checkpoint.setCheckpointPath(proj_dir) catch |err| {
            if (options.verbose) {
                style.print("Warning: Could not set checkpoint path: {}\n", .{err});
            }
        };

        // Create backup of current state
        checkpoint.createBackup(proj_dir) catch |err| {
            if (options.verbose) {
                style.print("Could not create backup: {}\n", .{err});
            }
        };

        // Load or create lockfile
        var lock_file = try lockfile_hooks.loadOrCreateLockfile(allocator, cwd);
        defer lock_file.deinit();

        // Execute pre-install hook
        if (try lockfile_hooks.executePreInstallHook(allocator, cwd, options.verbose)) |*pre_result| {
            defer {
                var r = pre_result.*;
                r.deinit(allocator);
            }
            if (!pre_result.success) {
                // Rollback on pre-install hook failure
                checkpoint.rollback() catch |err| {
                    style.print("Rollback failed: {}\n", .{err});
                };
                return .{
                    .exit_code = 1,
                    .message = try allocator.dupe(u8, "Pre-install hook failed"),
                };
            }
        }

        // Load .npmrc configuration for custom registries and auth tokens
        var npmrc_config = lib.config.loadNpmrc(allocator, cwd) catch lib.config.NpmrcConfig.init(allocator);
        defer npmrc_config.deinit();

        // Apply .npmrc registry override to environment if present
        if (npmrc_config.registry) |custom_registry| {
            if (options.verbose) {
                style.print("Using registry from .npmrc: {s}\n", .{custom_registry});
            }
        }

        // Clean Bun-style output - just show what we're installing
        style.printInstallingEx(deps_to_install.len, resuming_count);

        if (options.verbose) {
            const setup_ts = io_helper.clockGettime();
            const setup_ms = @as(i64, @intCast(setup_ts.sec)) * 1000 + @as(i64, @intCast(@divFloor(setup_ts.nsec, 1_000_000)));
            std.debug.print("[verbose:timer] setup phase complete: {d}ms\n", .{setup_ms - start_time});
        }

        // Install each dependency concurrently using a shared installer for deduplication
        var pkg_cache = try cache.PackageCache.init(allocator);
        defer pkg_cache.deinit();

        var shared_installer = try install.Installer.init(allocator, &pkg_cache);
        allocator.free(shared_installer.data_dir);
        shared_installer.data_dir = try allocator.dupe(u8, env_dir);
        shared_installer.modules_dir = options.modules_dir;
        shared_installer.verbose = options.verbose;

        // Scopes the project pinned to a Pantry registry resolve there only.
        var scope_diag: scopes.Diagnostic = .{};
        var scope_pins = scopes.loadForProject(allocator, proj_dir, &scope_diag) catch |err| {
            shared_installer.deinit();
            return scopePinsError(allocator, err, &scope_diag);
        };
        defer scope_pins.deinit();
        shared_installer.scope_pins = &scope_pins;

        // Configure installer with .npmrc settings
        if (npmrc_config.registry) |custom_registry| {
            shared_installer.setRegistryUrl(custom_registry);
        }

        // Wire up lockfile for lockfile-first resolution (skip npm registry on subsequent installs)
        shared_installer.setLockfile(&lock_file);
        shared_installer.native_policy = .{ .original_lock = &lock_file, .frozen = options.frozen_lockfile, .force = options.force, .exempt_domains = &env_only_domains.map };

        // Prefer bun.lock's pins for npm ranges they satisfy, so a project
        // locked by both pantry and Bun gets one tree (stacksjs/stacks#2848).
        var bun_pins = lib.deps.resolution.BunLockPins.load(allocator, proj_dir);
        defer if (bun_pins) |*pins| pins.deinit();
        if (bun_pins) |*pins| shared_installer.setBunLockPins(pins);

        defer shared_installer.deinit();

        // All restoration now goes through pipeline preflight, so native
        // sibling/frozen validation precedes cache materialization too.

        // ── Parallel pipeline: resolve tree → download → extract ──
        const pipeline = @import("../../../install/pipeline.zig");

        // A committed lock decides what gets installed. Every declared range
        // used to be resolved against the registry, so the newest match won
        // and the pin was rewritten; `--frozen-lockfile` installed that newer
        // release and only then failed (#260). A spec the pin no longer
        // satisfies still resolves afresh, so editing a dependency works.
        //
        // Checked before anything is installed, which is the other half of
        // the report: a frozen run must fail without having written to
        // `pantry/` first.
        if (options.frozen_lockfile) {
            for (deps_to_install) |dep| {
                if (helpers.effectiveDependencySource(dep) == .pantry and env_only_domains.contains(helpers.dependencyName(dep))) continue;
                if (helpers.effectiveDependencySource(dep) == .pantry or isProvisionalNpmDependency(dep)) continue;
                if ((try helpers.lockedDependencyVersionSatisfying(&lock_file, dep)) != null) continue;
                // `latest`-style specs are covered by any pin, so reaching
                // here means the lock does not cover this dependency at all,
                // or its pin falls outside the declared spec.
                style.printWarn("Lockfile does not satisfy {s}@{s} but --frozen-lockfile is set\n", .{ dep.name, dep.version });
                return .{
                    .exit_code = 1,
                    .message = try allocator.dupe(u8, "Error: lockfile is out of date (--frozen-lockfile)"),
                };
            }
        }

        // Build pipeline dep list
        var pipeline_deps = try allocator.alloc(pipeline.PipelineDep, deps_to_install.len);
        defer allocator.free(pipeline_deps);
        for (deps_to_install, 0..) |dep, di| {
            const selected_version = if (helpers.effectiveDependencySource(dep) == .pantry) dep.version else (try preferredPipelineVersion(&lock_file, dep)) orelse dep.version;
            pipeline_deps[di] = pipelineDependency(dep, selected_version);
        }

        var pipeline_result = pipeline.run(
            allocator,
            &shared_installer,
            pipeline_deps,
            proj_dir,
            options.verbose,
        ) catch |err| {
            if (err == error.NativeLockNotSatisfied) return .{ .exit_code = 1, .message = try allocator.dupe(u8, "Error: lockfile is out of date (--frozen-lockfile)") };
            return err;
        };
        defer pipeline_result.deinit(allocator);

        // Print results
        var success_count: usize = 0;
        var failed_count: usize = 0;

        for (pipeline_result.results) |result| {
            // Another platform's optional build: locked, not installed.
            if (result.name.len == 0 or result.lock_only) continue;
            if (result.success) {
                style.printInstalled(result.name, result.version);
                success_count += 1;
            } else {
                style.printFailed(result.name, result.version, result.error_msg);
                failed_count += 1;
            }
        }

        if (options.verbose) {
            const phase_ts = io_helper.clockGettime();
            const phase_ms = @as(i64, @intCast(phase_ts.sec)) * 1000 + @as(i64, @intCast(@divFloor(phase_ts.nsec, 1_000_000)));
            std.debug.print("[verbose:timer] parallel install phase complete: {d}ms\n", .{phase_ms - start_time});
        }

        // Handle local packages separately (they need special symlink handling)
        // Create pantry directory if it doesn't exist
        const pantry_dir = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ proj_dir, options.modules_dir });
        defer allocator.free(pantry_dir);
        try io_helper.makePath(pantry_dir);

        // Batch auto-discovery: collect all unresolved link: deps, scan directory tree once
        const link_cmds = @import("../link.zig");
        var auto_link_results: ?link_cmds.AutoLinkResults = null;
        defer if (auto_link_results) |*r| r.deinit();

        if (options.auto_link) {
            // Collect unresolved link: dep names
            var unresolved = std.ArrayList([]const u8).empty;
            defer unresolved.deinit(allocator);

            for (deps) |dep| {
                if (!helpers.isLinkDependency(dep.version)) continue;
                const link_name = dep.version[5..]; // Skip "link:"
                // Check if already registered as a global link
                if (try link_cmds.resolveLinkPath(allocator, link_name)) |existing| {
                    allocator.free(existing);
                    continue;
                }
                try unresolved.append(allocator, link_name);
            }

            if (unresolved.items.len > 0) {
                auto_link_results = try link_cmds.autoDiscoverAndLinkBatch(allocator, unresolved.items, options.link_search_paths);

                // Print auto-linked messages for discovered packages
                for (unresolved.items) |link_name| {
                    if (auto_link_results.?.get(link_name)) |discovered_path| {
                        style.printAutoLinked(link_name, discovered_path);
                    }
                }
            }
        }

        for (deps) |dep| {
            if (!helpers.isLocalDependency(dep)) continue;

            // Resolve local path (handles link:, ~/, absolute, and relative paths)
            // Note: auto-discovered deps are now registered as global links,
            // so resolveLinkVersion will find them via the symlink.
            const local_path = if (helpers.isLinkDependency(dep.version)) blk: {
                const resolved = try helpers.resolveLinkVersion(allocator, dep.version);
                break :blk resolved orelse {
                    style.printFailed(dep.name, dep.version, "not linked - run 'pantry link' in the package directory");
                    failed_count += 1;
                    continue;
                };
            } else if (std.mem.startsWith(u8, dep.version, "~/")) blk: {
                const home_path = try lib.Paths.home(allocator);
                defer allocator.free(home_path);
                const rel_path = dep.version[2..]; // Remove "~/"
                break :blk try std.fmt.allocPrint(allocator, "{s}/{s}", .{ home_path, rel_path });
            } else if (std.mem.startsWith(u8, dep.version, "/"))
                try allocator.dupe(u8, dep.version)
            else
                try std.fmt.allocPrint(allocator, "{s}/{s}", .{ cwd, dep.version });
            defer allocator.free(local_path);

            // Check if local path exists
            io_helper.accessAbsolute(local_path, .{}) catch {
                style.printWarning(dep.name, dep.version, "path not found");
                failed_count += 1;
                continue;
            };

            const pkg_name = if (std.mem.indexOf(u8, dep.name, ":")) |colon_pos|
                dep.name[colon_pos + 1 ..]
            else
                dep.name;

            // Create pantry/{package} directory structure
            const pkg_modules_dir = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ pantry_dir, pkg_name });
            defer allocator.free(pkg_modules_dir);
            try io_helper.makePath(pkg_modules_dir);

            // Validate the resolved package name for path safety
            if (std.mem.indexOf(u8, pkg_name, "..") != null or
                std.mem.indexOfScalar(u8, pkg_name, '\\') != null)
            {
                style.printFailed(dep.name, "", "invalid package name");
                failed_count += 1;
                continue;
            }

            // Create symlink to source directory for build system
            const src_link_path = try std.fmt.allocPrint(allocator, "{s}/src", .{pkg_modules_dir});
            defer allocator.free(src_link_path);

            const src_path = try std.fmt.allocPrint(allocator, "{s}/src", .{local_path});
            defer allocator.free(src_path);

            // Atomic symlink: try create first, replace if exists
            io_helper.symLink(src_path, src_link_path) catch |err| switch (err) {
                error.PathAlreadyExists => {
                    io_helper.deleteFile(src_link_path) catch {};
                    io_helper.symLink(src_path, src_link_path) catch {
                        style.printFailed(helpers.stripDisplayPrefix(dep.name), dep.version, "symlink failed");
                        failed_count += 1;
                        continue;
                    };
                },
                else => {
                    style.printFailed(helpers.stripDisplayPrefix(dep.name), dep.version, "symlink failed");
                    failed_count += 1;
                    continue;
                },
            };

            // Also create symlink in env bin directory for executables
            const link_path = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ bin_dir, pkg_name });
            defer allocator.free(link_path);

            // Atomic symlink: try create first, replace if exists
            io_helper.symLink(local_path, link_path) catch |symlink_err| switch (symlink_err) {
                error.PathAlreadyExists => {
                    io_helper.deleteFile(link_path) catch {};
                    io_helper.symLink(local_path, link_path) catch |err2| {
                        if (options.verbose) {
                            style.print("    Warning: Failed to create bin symlink {s}: {}\n", .{ link_path, err2 });
                        }
                    };
                },
                else => {
                    if (options.verbose) {
                        style.print("    Warning: Failed to create bin symlink {s}: {}\n", .{ link_path, symlink_err });
                    }
                },
            };

            // Create pantry/.bin directory and symlink binaries from zig-out/bin
            const local_bin_dir = try std.fmt.allocPrint(allocator, "{s}/{s}/.bin", .{ proj_dir, options.modules_dir });
            defer allocator.free(local_bin_dir);
            try io_helper.makePath(local_bin_dir);

            // Check for binaries in the linked package's zig-out/bin directory
            const zig_out_bin = try std.fmt.allocPrint(allocator, "{s}/zig-out/bin", .{local_path});
            defer allocator.free(zig_out_bin);

            // Use std.fs.Dir for iteration (Io.Dir doesn't have iterate() in Zig 0.16)
            if (io_helper.openDirAbsoluteForIteration(zig_out_bin)) |dir_val| {
                var dir = dir_val;
                defer dir.close();
                var iter = dir.iterate();
                while (iter.next() catch null) |entry| {
                    if (entry.kind == .file or entry.kind == .sym_link) {
                        // Validate entry name
                        if (std.mem.indexOfScalar(u8, entry.name, '/') != null or
                            std.mem.eql(u8, entry.name, ".."))
                        {
                            continue;
                        }

                        // Create symlink in pantry/.bin
                        const bin_src = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ zig_out_bin, entry.name });
                        defer allocator.free(bin_src);
                        const bin_dst = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ local_bin_dir, entry.name });
                        defer allocator.free(bin_dst);

                        // Atomic symlink: try create first, replace if exists
                        io_helper.symLink(bin_src, bin_dst) catch |sym_err| switch (sym_err) {
                            error.PathAlreadyExists => {
                                io_helper.deleteFile(bin_dst) catch {};
                                io_helper.symLink(bin_src, bin_dst) catch {};
                            },
                            else => {
                                if (options.verbose) {
                                    style.print("    Warning: Failed to create local bin symlink {s}: {}\n", .{ bin_dst, sym_err });
                                }
                            },
                        };
                    }
                }
            } else |_| {
                // No zig-out/bin directory, that's fine
            }

            const display_name = helpers.stripDisplayPrefix(dep.name);
            style.printLinked(display_name, dep.version);
            success_count += 1;
        }

        // Final pass: ensure pantry/.bin has symlinks for all installed package binaries.
        // Only run if there were actual installs (not all cache hits) to avoid expensive dir scan.
        if (success_count > 0) {
            helpers.ensureBinSymlinks(allocator, proj_dir, options.modules_dir);
        }

        // The resolution lock is the canonical file for this install path.
        // A second v2 writer used to emit a constraint-only lock here, only for
        // the resolution writer below to overwrite it moments later. Besides
        // format churn, that branch rejected every frozen install regardless
        // of whether its lock was current.
        var frozen_lockfile_changed = false;

        // Add successful packages to pantry.lock and record in checkpoint.
        for (pipeline_result.results) |result| {
            if (result.success and result.name.len > 0) {
                const clean_name = helpers.normalizePackageName(result.name);
                const resolved_url = try std.fmt.allocPrint(allocator, "registry:{s}@{s}", .{ clean_name, result.version });
                defer allocator.free(resolved_url);

                // An inferred service is outside the lock's contract, so it
                // is neither written to the lock nor able to report the lock
                // as out of date. It is still installed, and the checkpoint
                // below still records it.
                if (!env_only_domains.contains(helpers.resolvePackageAlias(clean_name))) {
                    if (options.frozen_lockfile) {
                        if (!resolutionLockMatches(&lock_file, clean_name, result.version, resolved_url) or
                            !lockIntegrityMatches(&lock_file, clean_name, result.integrity))
                            frozen_lockfile_changed = true;
                    } else if (!options.no_save) {
                        if (lockfile_hooks.getLockedVersionForPackage(&lock_file, clean_name)) |previous| {
                            if (!std.mem.eql(u8, previous.version, result.version))
                                style.printLockPinMoved(clean_name, previous.version, result.version, false);
                        }
                        try lockfile_hooks.addPackageToLockfile(&lock_file, clean_name, result.version, resolved_url, result.integrity);
                    }
                }
                // Nothing of it is on disk to record below.
                if (result.lock_only) continue;

                // Record successful package installation in checkpoint
                checkpoint.recordPackage(clean_name) catch |err| {
                    if (options.verbose) {
                        style.print("Could not record package in checkpoint: {}\n", .{err});
                    }
                };

                // Record installed files/directories
                const pkg_dir = try std.fmt.allocPrint(allocator, "{s}/{s}/{s}", .{ proj_dir, options.modules_dir, clean_name });
                defer allocator.free(pkg_dir);
                checkpoint.recordDir(pkg_dir) catch |err| {
                    if (options.verbose) {
                        style.print("Could not record directory in checkpoint: {}\n", .{err});
                    }
                };
            }
        }

        if (frozen_lockfile_changed) {
            style.printWarn("Lockfile would be modified but --frozen-lockfile is set\n", .{});
            return .{
                .exit_code = 1,
                .message = try allocator.dupe(u8, "Error: lockfile is out of date (--frozen-lockfile)"),
            };
        }

        if (!options.frozen_lockfile and !options.no_save)
            try lockfile_hooks.saveLockfile(&lock_file, cwd);

        // Apply patches from patchedDependencies in package.json
        {
            const patch_mod = @import("../../../install/patches.zig");
            const patch_result = patch_mod.applyPatches(allocator, proj_dir, options.verbose) catch |err| blk: {
                if (options.verbose) {
                    style.print("Warning: Failed to apply patches: {}\n", .{err});
                }
                break :blk patch_mod.PatchResult{ .applied = 0, .failed = 0, .skipped = 0 };
            };
            if (patch_result.applied > 0 or patch_result.failed > 0) {
                style.print("Patches: {d} applied", .{patch_result.applied});
                if (patch_result.failed > 0) {
                    style.print(", {s}{d} failed{s}", .{ style.red, patch_result.failed, style.reset });
                }
                style.print("\n", .{});
            }
        }

        // Sync build.zig.zon with installed zig deps
        {
            const zig_zon_sync = @import("../../../deps/zig_zon_sync.zig");
            zig_zon_sync.syncBuildZigZon(allocator, proj_dir, options.modules_dir, options.verbose) catch |err| {
                if (options.verbose) {
                    style.print("Warning: Failed to sync build.zig.zon: {}\n", .{err});
                }
            };
        }

        // Delegate to Composer for PHP deps if composer.json is present
        {
            const composer_delegate = @import("../../../deps/composer_delegate.zig");
            _ = composer_delegate.installPhpDeps(allocator, proj_dir, options.verbose) catch |err| {
                if (options.verbose) {
                    style.print("Warning: Composer delegation failed: {}\n", .{err});
                }
            };
        }

        // Delegate to bun/pnpm/yarn/npm for JS deps if package.json is present
        {
            const js_delegate = @import("../../../deps/js_delegate.zig");
            _ = js_delegate.installJsDepsWithPolicy(allocator, proj_dir, options.verbose, options.linker, options.frozen_lockfile, options.ignore_scripts) catch |err| {
                return .{
                    .exit_code = 1,
                    .message = try std.fmt.allocPrint(allocator, "JavaScript dependency installation failed: {s}", .{@errorName(err)}),
                };
            };
        }

        // Total = everything we actually acted on (top-level + transitive +
        // local links), so the summary is consistent with success_count. Using
        // deps.len (top-level only) produced nonsense like "9/3 packages
        // installed" when transitive deps pushed success_count past the
        // top-level count. With this, an all-success run reads "9 packages
        // installed" and a partial run reads e.g. "7/9 packages installed".
        const total_deps = success_count + failed_count;
        const end_ts = io_helper.clockGettime();
        const end_time = @as(i64, @intCast(end_ts.sec)) * 1000 + @as(i64, @intCast(@divFloor(end_ts.nsec, 1_000_000)));
        const elapsed_ms = @as(f64, @floatFromInt(end_time - start_time));
        // Name every failed package on stderr before the counts.
        if (failed_count > 0) style.printFailureReport();
        if (success_count > 0) {
            style.printSummary(success_count, total_deps, elapsed_ms);
        } else if (failed_count == 0) {
            // Genuinely nothing to do — everything already present.
            style.printCheckedSummary(success_count, total_deps, elapsed_ms);
        }
        // else: success_count == 0 AND something failed — don't print a green
        // "N packages up to date" line that contradicts the red failure summary
        // printed just below. The failure count is the only honest summary here.

        if (options.verbose) {
            std.debug.print("[verbose:timer] total install time: {d}ms\n", .{@as(i64, @intFromFloat(elapsed_ms))});
        }

        if (failed_count > 0) {
            style.printFailureCount(failed_count);

            if (options.verbose) {
                style.printWarn("Some packages failed. Use 'pantry clean' to reset, or fix errors and retry.\n", .{});
            }
        }

        // Flush batched analytics (single HTTP request in background thread)
        install.flushAnalytics(allocator);

        // Execute post-install hook
        if (try lockfile_hooks.executePostInstallHook(allocator, cwd, options.verbose)) |*post_result| {
            defer {
                var r = post_result.*;
                r.deinit(allocator);
            }
            if (!post_result.success) {
                style.printWarn("Post-install hook failed\n", .{});
                // Don't fail the install, just warn
            }
        }

        // Clean up checkpoint file on completion (resume rarely useful, avoids polluting project)
        checkpoint.cleanup();

        // Update env cache so shell:lookup finds this env on next cd (no binary re-scan needed)
        {
            const env_cache_mod = lib.cache.env_cache;
            var env_cache = lib.cache.EnvCache.initWithPersistence(allocator) catch null;
            if (env_cache) |*ec| {
                defer ec.deinit();

                const project_hash_for_cache = string.md5Hash(proj_dir);
                const dep_mtime: i128 = if (deps_file_path) |path| blk: {
                    const f = io_helper.cwd().openFile(io_helper.io, path, .{}) catch break :blk 0;
                    defer f.close(io_helper.io);
                    const fstat = f.stat(io_helper.io) catch break :blk 0;
                    break :blk @divFloor(fstat.mtime.toNanoseconds(), std.time.ns_per_s);
                } else 0;

                const now = @as(i64, @intCast((io_helper.clockGettime()).sec));
                const entry = allocator.create(env_cache_mod.Entry) catch null;
                if (entry) |e| {
                    e.* = .{
                        .hash = project_hash_for_cache,
                        .dep_file = allocator.dupe(u8, deps_file_path orelse "") catch "",
                        .dep_mtime = dep_mtime,
                        .path = allocator.dupe(u8, env_dir) catch "",
                        .env_vars = std.StringHashMap([]const u8).init(allocator),
                        .created_at = now,
                        .cached_at = now,
                        .last_validated = now,
                    };
                    ec.put(e) catch {};
                }
            }
        }

        // A package the manifest asked for and did not get is a failed install,
        // and the exit code has to say so.
        //
        // This path returned 0 unconditionally while the other three - named
        // installs, the companion deps file, and workspaces - all returned 1.
        // So `pantry install` reading a pantry.json printed "1 package(s)
        // failed to install" in red and then reported success to its caller,
        // which is the shape that does real damage: every script that runs
        // `pantry install && build` carried on into a build with a missing
        // system dependency, and the failure surfaced later as something else
        // entirely - a compiler not found, a binary that is not there.
        //
        // Everything counted in `failed_count` is a dependency that is absent:
        // it did not download, it is not linked, its path does not exist, its
        // name was unsafe, or its symlink could not be made. None of those is
        // a state a caller should be told is fine.
        return .{ .exit_code = manifestExitCode(failed_count) };
    }

    // Detect if we're in a project directory
    const detector = @import("../../../deps/detector.zig");
    const cwd = try io_helper.getCwdAlloc(allocator);
    defer allocator.free(cwd);

    const project_root = blk: {
        // Check for workspace context first — named installs should go to workspace root
        const ws_file = try detector.findWorkspaceFile(allocator, cwd);
        if (ws_file) |ws| {
            defer allocator.free(ws.path);
            // Use workspace root, not the member directory
            break :blk ws.root_dir; // root_dir is already allocated
        }

        const deps_file = try detector.findDepsFile(allocator, cwd);
        if (deps_file) |df| {
            defer allocator.free(df.path);
            break :blk try allocator.dupe(u8, std.fs.path.dirname(df.path) orelse cwd);
        }
        // If no deps file, use current directory as project root for local installs
        // This allows `pantry install <package>` to work in any directory
        break :blk try allocator.dupe(u8, cwd);
    };
    defer allocator.free(project_root);

    // Initialize package cache and installer
    var pkg_cache = try cache.PackageCache.init(allocator);
    defer pkg_cache.deinit();

    var installer = try install.Installer.init(allocator, &pkg_cache);
    installer.modules_dir = options.modules_dir;
    installer.verbose = options.verbose;
    defer installer.deinit();

    // `pantry install @hq/platform` honours the project's scope pins too.
    var scope_diag: scopes.Diagnostic = .{};
    var scope_pins = scopes.loadForProject(allocator, project_root, &scope_diag) catch |err|
        return scopePinsError(allocator, err, &scope_diag);
    defer scope_pins.deinit();
    installer.scope_pins = &scope_pins;

    // Start timing (millisecond precision)
    const start_ts2 = io_helper.clockGettime();
    const start_time = @as(i64, @intCast(start_ts2.sec)) * 1000 + @as(i64, @intCast(@divFloor(start_ts2.nsec, 1_000_000)));

    const user_requested_count = package_args.items.len;
    // Force bypasses version preference, not the recorded provider identity.
    var named_original = try lockfile_hooks.loadOrCreateLockfile(allocator, project_root);
    defer named_original.deinit();
    installer.native_policy = .{ .original_lock = &named_original, .frozen = options.frozen_lockfile, .force = options.force };
    if (!options.force) installer.setLockfile(&named_original);
    var named_requests: std.ArrayList(NamedInstallRequest) = .empty;
    defer {
        for (named_requests.items) |*request| request.deinit(allocator);
        named_requests.deinit(allocator);
    }

    var success_count: usize = 0;
    var failed_count: usize = 0;

    // Track successful installs for lockfile
    // Tracks packages we've installed so we can emit a lockfile entry per-pkg.
    // `integrity` is the SRI/hex hash captured from the resolver when available
    // — persisted into the lockfile so a subsequent `pantry install --frozen`
    // can re-verify the tarball against the pinned digest.
    var installed_packages = std.ArrayList(struct {
        name: []const u8,
        version: []const u8,
        source: lib.packages.PackageSource,
        direct: bool,
        integrity: ?[]const u8 = null,
    }).empty;
    defer {
        for (installed_packages.items) |pkg| {
            allocator.free(pkg.name);
            allocator.free(pkg.version);
            if (pkg.integrity) |integrity| allocator.free(integrity);
        }
        installed_packages.deinit(allocator);
    }

    for (package_args.items, 0..) |pkg_spec_str, arg_idx| {
        const is_transitive_dep = arg_idx >= user_requested_count;
        // Parse package spec (name@version). Scope-aware: a scoped name begins
        // with '@', so splitting on the FIRST '@' emptied the name and turned
        // the scope into the version — every scoped package resolved to nothing.
        const parts = helpers.splitPackageSpec(pkg_spec_str);
        const raw_name = parts.name;
        const version = parts.version;

        // Resolve aliases (e.g. "meilisearch" -> "meilisearch.com")
        const name = helpers.resolvePackageAlias(raw_name);

        // Check if package exists in pantry registry first
        const pkg_registry = @import("../../../packages/generated.zig");
        const pkg_info = pkg_registry.getPackageByName(name);

        // For Zig aliases, always route to Pantry's mirrored ziglang.org package.
        const is_zig_pkg = std.mem.eql(u8, name, "zig") or
            std.mem.eql(u8, name, "ziglang") or
            std.mem.eql(u8, name, "ziglang.org");

        // A name in a pinned scope resolves from its Pantry registry and
        // nowhere else; any failure is this package's install error.
        var pinned_resolution: ?install.Installer.NpmResolution = null;
        defer if (pinned_resolution) |r| {
            allocator.free(r.version);
            allocator.free(r.tarball_url);
            if (r.integrity) |i| allocator.free(i);
        };
        if (installer.pinFor(name) != null) {
            pinned_resolution = installer.resolveNpmPackage(name, version) catch |err| {
                const message = installer.describePinnedFailure(allocator, err, name, version);
                defer if (message) |m| allocator.free(m);
                style.printFailed(name, version, message orelse @errorName(err));
                failed_count += 1;
                continue;
            };
        }

        var discovered_version: ?[]const u8 = null;
        defer if (discovered_version) |owned| allocator.free(owned);
        var discovered_url: ?[]const u8 = null;
        defer if (discovered_url) |owned| allocator.free(owned);

        // Determine the package spec - use npm fallback if not in pantry registry
        const spec = if (pinned_resolution) |pinned| lib.packages.PackageSpec{
            .name = name,
            .version = pinned.version,
            .source = .npm,
            .url = pinned.tarball_url,
        } else if (is_zig_pkg) lib.packages.PackageSpec{
            .name = "ziglang.org",
            .version = version,
            .source = .pantry,
        } else if (pkg_info != null or hasNativeLockIdentity(&named_original, name)) lib.packages.PackageSpec{
            .name = name,
            .version = version,
        } else npm_fallback: {
            // The Pantry registry first, asked the question the caller asked:
            // an exact version is looked up as that version (the old lookup
            // took no version and installed whatever was newest, so exact pins
            // skipped Pantry entirely), and a range only accepts an answer
            // that satisfies it.
            //
            // A registry that says the name is its own and gated (401/402/403)
            // ends the search here. Falling back to npm under the same name is
            // how a private package gets swapped for a stranger's.
            if (helpers.lookupPantryForRequest(allocator, name, version, isExactVersion(version)) catch |err| {
                const message = helpers.gatedLookupMessage(allocator, err, name, version);
                defer if (message) |m| allocator.free(m);
                style.printFailed(name, version, message orelse @errorName(err));
                failed_count += 1;
                continue;
            }) |info| {
                var pantry_info = info;
                defer pantry_info.deinit(allocator);

                // Native discovery establishes provider identity only. The
                // completed plan resolves every authored range together.
                if (pantry_info.source == .pantry) break :npm_fallback lib.packages.PackageSpec{
                    .name = name,
                    .version = version,
                    .source = .pantry,
                };
                break :npm_fallback lib.packages.PackageSpec{
                    .name = name,
                    .version = blk: {
                        discovered_version = try allocator.dupe(u8, pantry_info.version);
                        break :blk discovered_version.?;
                    },
                    .source = pantry_info.source,
                    .url = blk: {
                        discovered_url = try allocator.dupe(u8, pantry_info.tarball_url);
                        break :blk discovered_url.?;
                    },
                };
            }

            // For domain-style packages (containing '.'), use pkgx source
            // which triggers S3 registry lookup in installer.zig.
            if (std.mem.indexOfScalar(u8, name, '.') != null) {
                break :npm_fallback lib.packages.PackageSpec{
                    .name = name,
                    .version = version,
                };
            }

            // Fall back to npm registry — fetch directly into memory (no temp file, no curl)
            const npm_url = std.fmt.allocPrint(allocator, "https://registry.npmjs.org/{s}", .{name}) catch {
                break :npm_fallback lib.packages.PackageSpec{ .name = name, .version = version, .source = .npm };
            };
            defer allocator.free(npm_url);

            const npm_response = io_helper.httpGet(allocator, npm_url) catch {
                break :npm_fallback lib.packages.PackageSpec{ .name = name, .version = version, .source = .npm };
            };
            defer allocator.free(npm_response);

            if (npm_response.len == 0) {
                break :npm_fallback lib.packages.PackageSpec{ .name = name, .version = version, .source = .npm };
            }

            // Parse npm response
            const parsed = std.json.parseFromSlice(std.json.Value, allocator, npm_response, .{}) catch {
                break :npm_fallback lib.packages.PackageSpec{ .name = name, .version = version, .source = .npm };
            };
            defer parsed.deinit();

            if (parsed.value != .object) {
                break :npm_fallback lib.packages.PackageSpec{ .name = name, .version = version, .source = .npm };
            }

            // Get target version
            const target_version = if (std.mem.eql(u8, version, "latest")) version_blk: {
                const dist_tags = parsed.value.object.get("dist-tags") orelse break :version_blk null;
                if (dist_tags != .object) break :version_blk null;
                const latest = dist_tags.object.get("latest") orelse break :version_blk null;
                if (latest != .string) break :version_blk null;
                break :version_blk latest.string;
            } else version;

            if (target_version == null) {
                break :npm_fallback lib.packages.PackageSpec{ .name = name, .version = version, .source = .npm };
            }

            // Get tarball URL
            const versions_obj = parsed.value.object.get("versions") orelse {
                break :npm_fallback lib.packages.PackageSpec{ .name = name, .version = version, .source = .npm };
            };
            if (versions_obj != .object) {
                break :npm_fallback lib.packages.PackageSpec{ .name = name, .version = version, .source = .npm };
            }

            const version_data = versions_obj.object.get(target_version.?) orelse {
                break :npm_fallback lib.packages.PackageSpec{ .name = name, .version = version, .source = .npm };
            };
            if (version_data != .object) {
                break :npm_fallback lib.packages.PackageSpec{ .name = name, .version = version, .source = .npm };
            }

            var tarball_url: ?[]const u8 = null;
            if (version_data.object.get("dist")) |dist| {
                if (dist == .object) {
                    if (dist.object.get("tarball")) |tarball| {
                        if (tarball == .string) {
                            // Validate URL scheme to prevent SSRF via file:// or other protocols
                            if (std.mem.startsWith(u8, tarball.string, "https://") or
                                std.mem.startsWith(u8, tarball.string, "http://"))
                            {
                                discovered_url = try allocator.dupe(u8, tarball.string);
                                tarball_url = discovered_url;
                            }
                        }
                    }
                }
            }

            break :npm_fallback lib.packages.PackageSpec{
                .name = name,
                .version = blk: {
                    discovered_version = try allocator.dupe(u8, target_version.?);
                    break :blk discovered_version.?;
                },
                .source = .npm,
                .url = tarball_url,
            };
        };

        var discovered_spec = spec;
        if (discovered_spec.source == .pantry) {
            if (pkg_info) |info| discovered_spec.name = info.domain;
        }
        try appendNamedRequest(allocator, &named_requests, discovered_spec, version, !is_transitive_dep, if (pinned_resolution) |resolved| resolved.integrity else null);
    }

    // Discovery has closed every authored native root before any payload.
    var named_native_plan = try collectNamedNativePlan(allocator, named_requests.items);
    defer named_native_plan.deinit();
    try validateNamedProviderOwnership(allocator, project_root, &named_native_plan);
    named_native_plan.resolve(installer.native_policy) catch |err| {
        if (err == error.NativeLockNotSatisfied) return .{ .exit_code = 1, .message = try allocator.dupe(u8, "Error: lockfile is out of date (--frozen-lockfile)") };
        return err;
    };
    for (named_native_plan.names.items) |domain| {
        var explicit = false;
        for (named_requests.items) |request| {
            if (request.spec.source == .pantry and std.mem.eql(u8, request.spec.name, domain)) {
                explicit = true;
                break;
            }
        }
        if (explicit) continue;
        try appendNamedRequest(allocator, &named_requests, .{ .name = domain, .version = try named_native_plan.versionFor(domain, "latest"), .source = .pantry }, "latest", false, null);
    }
    var prepared_archives = try installer.prepareNativeArchives(&named_native_plan, project_root, options.force);
    defer prepared_archives.deinit();
    style.printInstalling(user_requested_count);

    packages: for (named_requests.items) |request| {
        const is_transitive_dep = !request.direct;
        const name = request.spec.name;
        var spec = request.spec;
        if (spec.source == .pantry) spec.version = try named_native_plan.versionFor(spec.name, request.declared_constraint);

        // Show what we're installing
        style.print("  {s}>{s} {s}@{s}...", .{ style.dim, style.reset, name, spec.version });

        // A requested package whose install fails for a transient reason (the
        // network, a deadline, a registry gateway answer) gets one more try.
        // The HTTP layer already retries within its own deadline; this covers
        // the case it cannot, a Retry-After longer than that deadline.
        io_helper.resetTransientGetRecord();
        var retried = false;
        var http_capture: io_helper.TransientGetCapture = .{};
        // Unmigrated non-native and dedicated Zig paths retain their existing
        // diagnostic. Prepared generic native requests use only owned records.
        const owns_capture = spec.source == .pantry and !std.mem.eql(u8, spec.name, "ziglang.org");
        var result = attempt: while (true) {
            break :attempt installer.install(spec, .{
                .project_root = project_root,
                .quiet = false, // Show download progress
                .verbose = options.verbose,
                .expected_integrity = request.integrity,
                .record_integrity = installer.pinFor(name) != null,
                .native_plan = if (spec.source == .pantry) &named_native_plan else null,
                .prepared_archives = if (spec.source == .pantry) &prepared_archives else null,
                .http_capture = if (owns_capture) &http_capture else null,
                .force = options.force,
            }) catch |err| {
                style.clearLine();
                // Provide friendly error messages
                const base_msg = switch (err) {
                    error.PackageNotFound => "not found in pantry or npm registry",
                    error.NoTarballUrl => "npm package found but no tarball URL available",
                    else => style.friendlyErrorName(err),
                };
                var reason_buffer: [512]u8 = undefined;
                const transient = if (owns_capture) http_capture.record else io_helper.lastTransientGetRecord();
                const error_msg = describeInstallFailure(&reason_buffer, base_msg, transient, retried);
                if (native_deps.isPolicyError(err)) return err;
                if (!is_transitive_dep and !retried and style.isTransientInstallError(err)) {
                    retried = true;
                    const delay = transientRetryDelaySeconds(transient);
                    style.printForced("\n  ! {s}@{s}: {s} (transient); retrying once in {d}s\n", .{ name, spec.version, error_msg, delay });
                    io_helper.sleepMs(delay * 1000);
                    io_helper.resetTransientGetRecord();
                    http_capture = .{};
                    style.print("  {s}>{s} {s}@{s}...", .{ style.dim, style.reset, name, spec.version });
                    continue :attempt;
                }
                // A pulled-in transitive dep failing is non-fatal (it may lack a
                // build for this platform); only requested packages count as failures.
                if (is_transitive_dep) {
                    if (options.verbose)
                        style.print("{s}  ? optional dep {s}: {s}{s}\n", .{ style.dim, name, error_msg, style.reset });
                } else {
                    style.printFailed(name, spec.version, error_msg);
                    failed_count += 1;
                }
                continue :packages;
            };
        };

        defer result.deinit(allocator);

        style.clearLine();
        style.printInstalled(name, result.version);
        success_count += 1;

        // Track for lockfile
        const tracked_integrity: ?[]const u8 = if (result.integrity) |i|
            (allocator.dupe(u8, i) catch null)
        else
            null;
        installed_packages.append(allocator, .{
            .name = allocator.dupe(u8, name) catch continue,
            .version = allocator.dupe(u8, result.version) catch continue,
            .source = spec.source,
            .direct = !is_transitive_dep,
            .integrity = tracked_integrity,
        }) catch |err| {
            style.print("Warning: Failed to track installed package {s}: {}\n", .{ name, err });
            if (tracked_integrity) |ti| allocator.free(ti);
        };

        // Record the new dependency in the manifest (skip when --no-save).
        //
        // Only what the user actually asked for: `is_transitive_dep` entries are
        // the system-library closure we expanded above (node pulls in unicode.org,
        // openssl.org, zlib.net, curl.se/ca-certs), and listing those as direct
        // dependencies claims the project depends on them directly. Worse, they
        // were recorded at the *closure's* resolved version rather than the one
        // actually installed, so the manifest contradicted what was on disk.
        //
        // And route by source: system packages are declared in deps.yaml, npm
        // packages in package.json. Writing a domain like `curl.se/ca-certs` into
        // package.json left pnpm unable to install the project at all.
        if (!options.no_save and !options.frozen_lockfile and !is_transitive_dep) {
            if (spec.source == .pantry) {
                helpers.addDependencyToDepsYaml(allocator, project_root, name, result.version) catch |err| {
                    style.printWarn("Failed to update deps.yaml: {}\n", .{err});
                };
            } else {
                helpers.addDependencyToPackageJson(allocator, project_root, name, result.version, options.dev_only) catch |err| {
                    style.printWarn("Failed to update package.json: {}\n", .{err});
                };
            }
        }
    }

    // Ensure pantry/.bin has symlinks for all installed package binaries
    helpers.ensureBinSymlinks(allocator, project_root, options.modules_dir);

    // Generate/update lockfile for installed packages
    if (installed_packages.items.len > 0 and !options.no_save and !options.frozen_lockfile) {
        const lockfile_path = try std.fmt.allocPrint(allocator, "{s}/pantry.lock", .{project_root});
        defer allocator.free(lockfile_path);

        const lockfile_writer = @import("../../../packages/lockfile.zig");

        // Try to read existing lockfile first, or create a new one
        var lockfile = native_lock.read(allocator, lockfile_path) catch |err| blk: {
            // If file doesn't exist or is invalid, create a new lockfile
            if (err == error.FileNotFound or err == error.InvalidLockfile) {
                break :blk lib.packages.Lockfile.init(allocator, "1.0.0") catch |init_err| {
                    style.printWarn("Failed to create lockfile: {}\n", .{init_err});
                    return .{ .exit_code = 1 };
                };
            }
            style.printWarn("Failed to read lockfile: {}\n", .{err});
            return .{ .exit_code = 1 };
        };
        defer lockfile.deinit(allocator);

        // Add new packages to the lockfile (replace existing versions of same package)
        for (installed_packages.items) |pkg| {
            try recordNamedSystemConstraint(allocator, &lockfile, pkg.name, pkg.version, pkg.source, pkg.direct);

            var selected = if (native_identity.isNative(pkg.source))
                try native_lock.selectedEntry(allocator, &lockfile, pkg.name, pkg.version, pkg.integrity)
            else
                lib.packages.LockfileEntry{
                    .name = try allocator.dupe(u8, pkg.name),
                    .version = try allocator.dupe(u8, pkg.version),
                    .source = pkg.source,
                    .integrity = if (pkg.integrity) |value| try allocator.dupe(u8, value) else null,
                };
            var transferred = false;
            defer if (!transferred) selected.deinit(allocator);

            // First, remove any existing entries for this package (different versions)
            var keys_to_remove = std.ArrayList([]const u8).empty;
            defer keys_to_remove.deinit(allocator);

            var iter = lockfile.packages.iterator();
            while (iter.next()) |existing| {
                const existing_key = existing.key_ptr.*;
                if (!existing.value_ptr.matchesSource(pkg.source)) continue;
                // Check if this is the same package (starts with "name@")
                if (std.mem.startsWith(u8, existing_key, pkg.name)) {
                    if (existing_key.len > pkg.name.len and existing_key[pkg.name.len] == '@') {
                        keys_to_remove.append(allocator, existing_key) catch continue;
                    }
                }
            }

            // Remove old versions
            for (keys_to_remove.items) |old_key| {
                if (lockfile.packages.fetchRemove(old_key)) |kv| {
                    var old_entry = kv.value;
                    old_entry.deinit(allocator);
                    allocator.free(kv.key);
                }
            }

            const key = try std.fmt.allocPrint(allocator, "{s}@{s}", .{ pkg.name, pkg.version });
            defer allocator.free(key);
            try lockfile.addEntry(allocator, key, selected);
            transferred = true;
        }

        // Write merged lockfile
        style.printLockfileSaving();
        lockfile_writer.writeLockfile(allocator, &lockfile, lockfile_path) catch |err| {
            style.printWarn("Failed to write lockfile: {}\n", .{err});
            return .{ .exit_code = 1 };
        };
        style.printLockfileSaved();
    }

    // Clean summary with timing
    const end_ts2 = io_helper.clockGettime();
    const end_time = @as(i64, @intCast(end_ts2.sec)) * 1000 + @as(i64, @intCast(@divFloor(end_ts2.nsec, 1_000_000)));
    const elapsed_ms = @as(f64, @floatFromInt(end_time - start_time));

    // Name every failed package on stderr before the counts.
    if (failed_count > 0) style.printFailureReport();
    style.printSummary(success_count, package_args.items.len, elapsed_ms);

    if (failed_count > 0) {
        style.printFailureCount(failed_count);
        return .{ .exit_code = 1 };
    }

    return .{ .exit_code = 0 };
}

/// A failed install's reason, with the registry's last gateway answer when one
/// came before it: a bare `timed out` says nothing about the HTTP 503 that
/// spent the deadline (CI job 7047).
fn describeInstallFailure(
    buffer: []u8,
    base: []const u8,
    transient: ?io_helper.TransientGetRecord,
    retried: bool,
) []const u8 {
    var writer: std.Io.Writer = .fixed(buffer);
    writer.writeAll(base) catch return base;
    if (transient) |record| {
        writer.print("; registry answered HTTP {d}", .{record.status}) catch return base;
        if (record.retry_after_seconds > 0) writer.print(" (Retry-After {d}s)", .{record.retry_after_seconds}) catch return base;
    }
    if (retried) writer.writeAll("; failed again after one retry") catch return base;
    return writer.buffered();
}

/// How long to wait before the one package-level retry: what the registry
/// asked for, bounded to 5-60 s, or 10 s when it asked for nothing.
fn transientRetryDelaySeconds(transient: ?io_helper.TransientGetRecord) u64 {
    const record = transient orelse return 10;
    if (record.retry_after_seconds == 0) return 10;
    return std.math.clamp(@as(u64, record.retry_after_seconds), 5, 60);
}

test "install failure reasons keep the registry answer and the retry" {
    var buffer: [512]u8 = undefined;
    try std.testing.expectEqualStrings(
        "timed out; registry answered HTTP 503 (Retry-After 60s); failed again after one retry",
        describeInstallFailure(&buffer, "timed out", .{ .status = 503, .retry_after_seconds = 60 }, true),
    );
    try std.testing.expectEqualStrings("checksum mismatch", describeInstallFailure(&buffer, "checksum mismatch", null, false));
    try std.testing.expect(style.isTransientReason(describeInstallFailure(&buffer, "registry unavailable", .{ .status = 503, .retry_after_seconds = 0 }, false)));
}

test "the package-level retry waits a bounded time" {
    try std.testing.expectEqual(@as(u64, 10), transientRetryDelaySeconds(null));
    try std.testing.expectEqual(@as(u64, 60), transientRetryDelaySeconds(.{ .status = 503, .retry_after_seconds = 600 }));
    try std.testing.expectEqual(@as(u64, 5), transientRetryDelaySeconds(.{ .status = 429, .retry_after_seconds = 1 }));
    try std.testing.expectEqual(@as(u64, 10), transientRetryDelaySeconds(.{ .status = 502, .retry_after_seconds = 0 }));
}

/// Named installs write a caret constraint for the resolved version to deps.yaml.
/// Keep an existing workspace's system constraint in sync with that declaration,
/// well as the package pin below. Otherwise the next frozen project install
/// sees the old runtime constraint even though the named install succeeded.
/// Dependencies pulled in by that runtime must not become direct declarations.
fn recordNamedSystemConstraint(
    allocator: std.mem.Allocator,
    lockfile: *lib.packages.Lockfile,
    name: []const u8,
    version: []const u8,
    source: lib.packages.PackageSource,
    direct: bool,
) !void {
    if (!direct or source != .pantry) return;
    const root = lockfile.workspaces.getPtr("") orelse return;
    if (root.system == null)
        root.system = std.StringHashMap([]const u8).init(allocator);

    const owned_version = try std.fmt.allocPrint(allocator, "^{s}", .{version});
    errdefer allocator.free(owned_version);
    if (root.system.?.getPtr(name)) |existing| {
        allocator.free(existing.*);
        existing.* = owned_version;
    } else {
        const owned_name = try allocator.dupe(u8, name);
        errdefer allocator.free(owned_name);
        try root.system.?.put(owned_name, owned_version);
    }
}

test "named system installs refresh only successful direct workspace constraints" {
    const allocator = std.testing.allocator;
    const t = std.testing;
    var lockfile = try lib.packages.Lockfile.init(allocator, "1.0.0");
    defer lockfile.deinit(allocator);
    var system = std.StringHashMap([]const u8).init(allocator);
    try system.put(try allocator.dupe(u8, "bun.sh"), try allocator.dupe(u8, "1.3.14"));
    try system.put(try allocator.dupe(u8, "ziglang.org"), try allocator.dupe(u8, "0.16.0"));
    try lockfile.addWorkspace(allocator, "", .{
        .name = try allocator.dupe(u8, "fixture"),
        .system = system,
    });
    try lockfile.addWorkspace(allocator, "packages/ui", .{
        .name = try allocator.dupe(u8, "@fixture/ui"),
    });
    try lockfile.addEntry(allocator, "lit@3.3.1", .{
        .name = try allocator.dupe(u8, "lit"),
        .version = try allocator.dupe(u8, "3.3.1"),
        .source = .npm,
    });

    try recordNamedSystemConstraint(allocator, &lockfile, "bun.sh", "1.4.3", .pantry, true);
    try recordNamedSystemConstraint(allocator, &lockfile, "openssl.org", "3.6.0", .pantry, false);
    try recordNamedSystemConstraint(allocator, &lockfile, "lit", "3.4.0", .npm, true);
    const root = lockfile.workspaces.get("").?.system.?;
    try t.expectEqualStrings("^1.4.3", root.get("bun.sh").?);
    try t.expectEqualStrings("0.16.0", root.get("ziglang.org").?);
    try t.expectEqual(@as(u32, 2), root.count());
    try t.expect(lockfile.workspaces.get("packages/ui") != null);
    try t.expectEqualStrings("3.3.1", lockfile.packages.get("lit@3.3.1").?.version);
}

test "package.json delegates ordinary JS dependency sources" {
    try std.testing.expect(!shouldInstallWithNativePipeline(true, .registry));
    try std.testing.expect(!shouldInstallWithNativePipeline(true, .npm));
    try std.testing.expect(!shouldInstallWithNativePipeline(true, .github));
    try std.testing.expect(!shouldInstallWithNativePipeline(true, .git));
    try std.testing.expect(!shouldInstallWithNativePipeline(true, .url));
}

test "package.json keeps explicit Pantry dependencies native" {
    try std.testing.expect(shouldInstallWithNativePipeline(true, .pantry));
    try std.testing.expect(shouldInstallWithNativePipeline(false, .npm));
}

fn mergeCompanionResult(allocator: std.mem.Allocator, final_result: *types.CommandResult, result: anyerror!types.CommandResult, deps_path: []const u8) !void {
    if (result) |value| {
        var companion = value;
        defer companion.deinit(allocator);
        if (companion.exit_code != 0 and final_result.exit_code == 0) {
            final_result.exit_code = companion.exit_code;
            if (final_result.message) |message| allocator.free(message);
            final_result.message = companion.message;
            companion.message = null;
        }
    } else |err| {
        if (final_result.exit_code == 0) {
            final_result.exit_code = 1;
            if (final_result.message) |message| allocator.free(message);
            final_result.message = null;
            final_result.message = try std.fmt.allocPrint(allocator, "Error installing {s}: {s}", .{ std.fs.path.basename(deps_path), @errorName(err) });
        }
    }
}

fn finalizeCombinedWorkspaceLock(allocator: std.mem.Allocator, project_root: []const u8, generated_path: []const u8, frozen: bool, result: *types.CommandResult) !void {
    if (result.exit_code != 0) return;
    const committed_path = try std.fs.path.join(allocator, &.{ project_root, "pantry.lock" });
    defer allocator.free(committed_path);
    if (!frozen) return std.Io.Dir.renameAbsolute(generated_path, committed_path, io_helper.getIo());

    const writer = @import("../../../packages/lockfile.zig");
    var committed = native_lock.read(allocator, committed_path) catch null;
    defer if (committed) |*lockfile| lockfile.deinit(allocator);
    var generated = native_lock.read(allocator, generated_path) catch null;
    defer if (generated) |*lockfile| lockfile.deinit(allocator);
    const matches = if (committed) |*existing|
        if (generated) |*candidate| writer.lockfilesEqual(existing, candidate) else false
    else
        false;
    if (!matches) {
        result.exit_code = 1;
        if (result.message) |message| allocator.free(message);
        result.message = null;
        result.message = try allocator.dupe(u8, "Error: lockfile is out of date (--frozen-lockfile)");
    }
}

test "companion exceptions fail the workspace install and preserve its committed lock" {
    const allocator = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.lock", .data = "committed complete lock" });
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "staged.lock", .data = "workspace only lock" });
    const cwd_path = try io_helper.getCwdAlloc(allocator);
    defer allocator.free(cwd_path);
    const root = try std.fs.path.join(allocator, &.{ cwd_path, ".zig-cache", "tmp", directory.sub_path[0..] });
    defer allocator.free(root);
    const staged = try std.fs.path.join(allocator, &.{ root, "staged.lock" });
    defer allocator.free(staged);
    var result = types.CommandResult{ .exit_code = 0 };
    defer result.deinit(allocator);
    try mergeCompanionResult(allocator, &result, error.InvalidDependencyFile, "deps.yaml");
    try std.testing.expectEqual(@as(u8, 1), result.exit_code);
    try std.testing.expectEqualStrings("Error installing deps.yaml: InvalidDependencyFile", result.message.?);
    try finalizeCombinedWorkspaceLock(allocator, root, staged, false, &result);
    const committed = try directory.dir.readFileAlloc(io_helper.io, "pantry.lock", allocator, .limited(1024));
    defer allocator.free(committed);
    try std.testing.expectEqualStrings("committed complete lock", committed);
}

test "successful companion workspace installs publish the complete staged lock" {
    const allocator = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.lock", .data = "previous complete lock" });
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "staged.lock", .data = "new complete lock" });
    const cwd_path = try io_helper.getCwdAlloc(allocator);
    defer allocator.free(cwd_path);
    const root = try std.fs.path.join(allocator, &.{ cwd_path, ".zig-cache", "tmp", directory.sub_path[0..] });
    defer allocator.free(root);
    const staged = try std.fs.path.join(allocator, &.{ root, "staged.lock" });
    defer allocator.free(staged);
    var result = types.CommandResult{ .exit_code = 0 };
    defer result.deinit(allocator);
    try mergeCompanionResult(allocator, &result, types.CommandResult{ .exit_code = 0 }, "deps.yaml");
    try finalizeCombinedWorkspaceLock(allocator, root, staged, false, &result);
    try std.testing.expectEqual(@as(u8, 0), result.exit_code);
    const committed = try directory.dir.readFileAlloc(io_helper.io, "pantry.lock", allocator, .limited(1024));
    defer allocator.free(committed);
    try std.testing.expectEqualStrings("new complete lock", committed);
    try std.testing.expectError(error.FileNotFound, directory.dir.access(io_helper.io, "staged.lock", .{}));
}

/// Install a companion deps file (e.g. deps.yaml) when a workspace manifest (package.json)
/// was already installed. Keeps system/runtime deps in sync for monorepos.
fn installCompanionDepsFile(
    allocator: std.mem.Allocator,
    df: @import("../../../deps/detector.zig").DepsFile,
    project_root: []const u8,
    options: types.InstallOptions,
    lockfile_path: ?[]const u8,
) !types.CommandResult {
    const parser = @import("../../../deps/parser.zig");
    const pipeline = @import("../../../install/pipeline.zig");

    const declared_deps = options.companion_declarations orelse try parser.inferDependencies(allocator, df);
    defer if (options.companion_declarations == null) {
        for (declared_deps) |*dep| {
            var owned_dep = dep.*;
            owned_dep.deinit(allocator);
        }
        allocator.free(declared_deps);
    };

    // Services the project's .env names, unless declared (#36). What they
    // resolve to is installed but never locked (#253), so a frozen run infers
    // exactly what any other run does.
    const env_inferred = options.companion_inferred orelse (env_deps.infer(allocator, project_root, declared_deps, .{}) catch &.{});
    defer if (options.companion_inferred == null) env_deps.freeDeps(allocator, env_inferred);
    const deps = if (env_inferred.len == 0) declared_deps else try std.mem.concat(allocator, parser.PackageDependency, &.{ declared_deps, env_inferred });
    defer if (env_inferred.len > 0) allocator.free(deps);
    if (deps.len == 0) return .{ .exit_code = 0 };

    // The workspace phase may have produced an npm-only staged output. Native
    // selection must use the still-committed complete lock, never that output.
    // Force bypasses preference; an explicit frozen request still validates
    // committed coverage before resolving. Validation is not pin preference.
    const session_original = if (options.native_session) |session| session.original_lock else null;
    var owned_lock_file: ?lib.deps.resolution.LockFile = if (session_original == null)
        if (options.native_session != null or (options.force and !options.frozen_lockfile)) lib.deps.resolution.LockFile.init(allocator) else try lockfile_hooks.loadOrCreateLockfile(allocator, project_root)
    else
        null;
    defer if (owned_lock_file) |*original| original.deinit();
    const lock_file = session_original orelse &owned_lock_file.?;
    var env_only_domains = if (options.native_session) |session|
        env_deps.DomainSet{ .allocator = allocator, .map = session.exempt_domains }
    else
        try env_deps.inferredOnlyDomains(allocator, env_inferred, declared_deps);
    defer if (options.native_session == null) env_only_domains.deinit();

    var pipeline_deps = try allocator.alloc(pipeline.PipelineDep, deps.len);
    defer allocator.free(pipeline_deps);
    for (deps, 0..) |dep, di| {
        const clean_name = helpers.dependencyName(dep);
        const native = helpers.effectiveDependencySource(dep) == .pantry;
        const env_only = native and env_only_domains.contains(clean_name);
        const locked_version = if (native or env_only or (options.force and !options.frozen_lockfile))
            null
        else
            try preferredPipelineVersion(lock_file, dep);
        if (options.frozen_lockfile and !native and !isProvisionalNpmDependency(dep) and !env_only and locked_version == null) {
            style.printWarn("Lockfile does not satisfy {s}@{s} but --frozen-lockfile is set\n", .{ dep.name, dep.version });
            return .{
                .exit_code = 1,
                .message = try allocator.dupe(u8, "Error: lockfile is out of date (--frozen-lockfile)"),
            };
        }
        pipeline_deps[di] = pipelineDependency(dep, if (options.force) dep.version else locked_version orelse dep.version);
    }

    const proj_basename = std.fs.path.basename(project_root);

    var proj_hasher = std.crypto.hash.Md5.init(.{});
    proj_hasher.update(project_root);
    var proj_hash: [16]u8 = undefined;
    proj_hasher.final(&proj_hash);
    const proj_hash_short = try std.fmt.allocPrint(allocator, "{x:0>8}", .{std.mem.readInt(u32, proj_hash[0..4], .little)});
    defer allocator.free(proj_hash_short);

    var dep_hasher = std.crypto.hash.Md5.init(.{});
    dep_hasher.update(df.path);
    var dep_hash: [16]u8 = undefined;
    dep_hasher.final(&dep_hash);
    const dep_hash_hex = try string.hashToHex(dep_hash, allocator);
    defer allocator.free(dep_hash_hex);
    const dep_hash_short = try std.fmt.allocPrint(allocator, "d{s}", .{dep_hash_hex[0..8]});
    defer allocator.free(dep_hash_short);

    const data_dir = try lib.Paths.data(allocator);
    defer allocator.free(data_dir);

    const env_name = try std.fmt.allocPrint(allocator, "{s}_{s}-{s}", .{ proj_basename, proj_hash_short, dep_hash_short });
    defer allocator.free(env_name);

    const env_dir = try std.fs.path.join(allocator, &[_][]const u8{ data_dir, "envs", env_name });
    defer allocator.free(env_dir);

    try io_helper.makePath(env_dir);
    const bin_dir = try std.fmt.allocPrint(allocator, "{s}/bin", .{env_dir});
    defer allocator.free(bin_dir);
    try io_helper.makePath(bin_dir);

    style.printInstalling(deps.len);

    var pkg_cache = try cache.PackageCache.init(allocator);
    defer pkg_cache.deinit();

    var shared_installer = try install.Installer.init(allocator, &pkg_cache);
    allocator.free(shared_installer.data_dir);
    shared_installer.data_dir = try allocator.dupe(u8, env_dir);
    shared_installer.modules_dir = options.modules_dir;
    shared_installer.verbose = options.verbose;
    defer shared_installer.deinit();
    if (!options.force) shared_installer.setLockfile(lock_file);
    shared_installer.native_session = options.native_session;
    shared_installer.native_policy = if (options.native_session) |session| session.policy() else .{ .original_lock = lock_file, .frozen = options.frozen_lockfile, .force = options.force, .exempt_domains = &env_only_domains.map };

    var scope_diag: scopes.Diagnostic = .{};
    var scope_pins = scopes.loadForProject(allocator, project_root, &scope_diag) catch |err|
        return scopePinsError(allocator, err, &scope_diag);
    defer scope_pins.deinit();
    shared_installer.scope_pins = &scope_pins;

    var pipeline_result = pipeline.run(allocator, &shared_installer, pipeline_deps, project_root, options.verbose) catch |err| {
        if (err == error.NativeLockNotSatisfied) return .{ .exit_code = 1, .message = try allocator.dupe(u8, "Error: lockfile is out of date (--frozen-lockfile)") };
        return err;
    };
    defer pipeline_result.deinit(allocator);

    var failed_count: usize = 0;
    for (pipeline_result.results) |result| {
        if (result.name.len == 0 or result.lock_only) continue;
        if (result.success) {
            style.printInstalled(result.name, result.version);
        } else {
            style.printFailed(result.name, result.version, result.error_msg);
            failed_count += 1;
        }
    }

    if (failed_count > 0) {
        return .{
            .exit_code = 1,
            .message = try std.fmt.allocPrint(allocator, "{d} system package(s) failed to install from {s}", .{ failed_count, std.fs.path.basename(df.path) }),
        };
    }

    // Merge the resolved native packages into the workspace's lock output,
    // which may still be private staging until both phases succeed. Normal
    // resolution refreshes only missing or incompatible runtime pins while
    // preserving every workspace and npm entry.
    if (!options.no_save) {
        // `declared_deps`, not `deps`: the constraints recorded on the root
        // workspace are the ones the workspace declares. `env_only_domains`
        // keeps the same inference out of the resolved package entries, where
        // it arrives with everything it pulled in.
        // Frozen resolution remains strict. A private combined output can be
        // written provisionally; finalization compares it with the original
        // complete lock before publishing anything to pantry.lock.
        const frozen_output = options.frozen_lockfile and lockfile_path == null;
        const lockfile_changed = try syncCompanionLockfile(
            allocator,
            project_root,
            declared_deps,
            pipeline_result.results,
            &env_only_domains,
            frozen_output,
            lockfile_path,
        );
        if (frozen_output and lockfile_changed) {
            return .{
                .exit_code = 1,
                .message = try allocator.dupe(u8, "Error: lockfile is out of date (--frozen-lockfile)"),
            };
        }
    }

    return .{ .exit_code = 0 };
}

test "native plan consumes the existing inferred-only closure without exempting declared shared dependencies" {
    const allocator = std.testing.allocator;
    const Dependency = lib.deps.parser.PackageDependency;
    const inferred = [_]Dependency{.{ .name = "postgresql.org", .version = "latest", .source = .pantry }};
    var only_env = try env_deps.inferredOnlyDomains(allocator, &inferred, &.{});
    defer only_env.deinit();
    var inferred_plan = native_deps.Plan.init(allocator);
    defer inferred_plan.deinit();
    try inferred_plan.add("postgresql.org", "latest");
    try inferred_plan.expand();
    try inferred_plan.preflight(.{ .frozen = true, .exempt_domains = &only_env.map });
    const declared = [_]Dependency{.{ .name = "gnome.org/libxslt", .version = "latest", .source = .pantry }};
    var shared = try env_deps.inferredOnlyDomains(allocator, &inferred, &declared);
    defer shared.deinit();
    var shared_plan = native_deps.Plan.init(allocator);
    defer shared_plan.deinit();
    try shared_plan.add("postgresql.org", "latest");
    try shared_plan.add("gnome.org/libxslt", "latest");
    try shared_plan.expand();
    try std.testing.expectError(error.NativeLockNotSatisfied, shared_plan.preflight(.{ .frozen = true, .exempt_domains = &shared.map }));
}

test "companion frozen preflight uses the committed lock instead of staged output" {
    const allocator = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "deps.yaml", .data = "dependencies:\n  lz4.org: ^1.10.0\n" });
    const cwd_path = try io_helper.getCwdAlloc(allocator);
    defer allocator.free(cwd_path);
    const root = try std.fs.path.join(allocator, &.{ cwd_path, ".zig-cache", "tmp", directory.sub_path[0..] });
    defer allocator.free(root);
    const deps_path = try std.fs.path.join(allocator, &.{ root, "deps.yaml" });
    defer allocator.free(deps_path);
    const staged_path = try std.fs.path.join(allocator, &.{ root, "staged.lock" });
    defer allocator.free(staged_path);
    var staged = lib.deps.resolution.LockFile.init(allocator);
    defer staged.deinit();
    try staged.addPackage("lz4.org", "1.10.0", "registry:lz4.org@1.10.0", null);
    try staged.write(staged_path);
    const before = try directory.dir.readFileAlloc(io_helper.io, "staged.lock", allocator, .limited(4096));
    defer allocator.free(before);
    var result = try installCompanionDepsFile(allocator, .{ .path = deps_path, .format = .deps_yaml }, root, .{ .frozen_lockfile = true }, staged_path);
    defer result.deinit(allocator);
    try std.testing.expectEqual(@as(u8, 1), result.exit_code);
    try std.testing.expectEqualStrings("Error: lockfile is out of date (--frozen-lockfile)", result.message.?);
    const after = try directory.dir.readFileAlloc(io_helper.io, "staged.lock", allocator, .limited(4096));
    defer allocator.free(after);
    try std.testing.expectEqualStrings(before, after);
    try std.testing.expectError(error.FileNotFound, directory.dir.access(io_helper.io, "pantry.lock", .{}));
}

test "ambiguous companion native pins fail normal and frozen resolution before installation" {
    const allocator = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "deps.yaml", .data = "dependencies:\n  lz4.org: ^1\n" });
    const cwd_path = try io_helper.getCwdAlloc(allocator);
    defer allocator.free(cwd_path);
    const root = try std.fs.path.join(allocator, &.{ cwd_path, ".zig-cache", "tmp", directory.sub_path[0..] });
    defer allocator.free(root);
    const deps_path = try std.fs.path.join(allocator, &.{ root, "deps.yaml" });
    defer allocator.free(deps_path);
    const lock_path = try std.fs.path.join(allocator, &.{ root, "pantry.lock" });
    defer allocator.free(lock_path);
    var lock = try lib.deps.resolution.LockFile.parse(allocator,
        \\{"packages":{
        \\  "lz4.org@1.10.0":{"name":"lz4.org","version":"1.10.0","resolved":"registry:lz4.org@1.10.0"},
        \\  "lz4.org@1.11.0":{"name":"lz4.org","version":"1.11.0","resolved":"registry:lz4.org@1.11.0"}
        \\}}
    );
    defer lock.deinit();
    try lock.write(lock_path);
    const before = try directory.dir.readFileAlloc(io_helper.io, "pantry.lock", allocator, .limited(4096));
    defer allocator.free(before);
    try std.testing.expectError(error.AmbiguousLockedVersion, installCompanionDepsFile(allocator, .{ .path = deps_path, .format = .deps_yaml }, root, .{}, null));
    try std.testing.expectError(error.AmbiguousLockedVersion, installCompanionDepsFile(allocator, .{ .path = deps_path, .format = .deps_yaml }, root, .{ .frozen_lockfile = true }, null));
    const after = try directory.dir.readFileAlloc(io_helper.io, "pantry.lock", allocator, .limited(4096));
    defer allocator.free(after);
    try std.testing.expectEqualStrings(before, after);
    try std.testing.expectError(error.FileNotFound, directory.dir.access(io_helper.io, "pantry", .{}));
}

/// Merge packages installed from a workspace's companion deps file into the
/// comprehensive v2 lockfile. Returns true when the lockfile content changed.
fn syncCompanionLockfile(
    allocator: std.mem.Allocator,
    project_root: []const u8,
    deps: []const @import("../../../deps/parser.zig").PackageDependency,
    results: []const @import("../../../install/pipeline.zig").PackageResult,
    env_only_domains: *const env_deps.DomainSet,
    frozen: bool,
    lockfile_path_override: ?[]const u8,
) !bool {
    const lockfile_writer = @import("../../../packages/lockfile.zig");
    const owned_lockfile_path = if (lockfile_path_override == null)
        try std.fs.path.join(allocator, &.{ project_root, "pantry.lock" })
    else
        null;
    defer if (owned_lockfile_path) |path| allocator.free(path);
    const lockfile_path = lockfile_path_override orelse owned_lockfile_path.?;

    var original: ?lib.packages.Lockfile = native_lock.read(allocator, lockfile_path) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
    defer if (original) |*lockfile| lockfile.deinit(allocator);

    var lockfile = if (original != null)
        try native_lock.read(allocator, lockfile_path)
    else
        try lib.packages.Lockfile.init(allocator, "1.0.0");
    defer lockfile.deinit(allocator);

    const committed_path = if (lockfile_path_override != null) try std.fs.path.join(allocator, &.{ project_root, "pantry.lock" }) else null;
    defer if (committed_path) |path| allocator.free(path);
    var committed = if (committed_path) |path| native_lock.read(allocator, path) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    } else null;
    defer if (committed) |*view| view.deinit(allocator);
    try mergeCompanionLockfileEntriesUsingMetadata(allocator, &lockfile, deps, results, env_only_domains, if (committed) |*view| view else null);

    const changed = if (original) |*existing|
        (!frozen and existing.native_identity_changed) or !lockfile_writer.lockfilesEqual(existing, &lockfile)
    else
        true;

    if (changed and !frozen) {
        style.printLockfileSaving();
        try lockfile_writer.writeLockfile(allocator, &lockfile, lockfile_path);
        style.printLockfileSaved();
    }

    return changed;
}

/// Update the in-memory lockfile while retaining unrelated workspace/package
/// data. Kept separate from disk I/O so the merge behavior is regression tested.
fn mergeCompanionLockfileEntries(
    allocator: std.mem.Allocator,
    lockfile: *lib.packages.Lockfile,
    deps: []const @import("../../../deps/parser.zig").PackageDependency,
    results: []const @import("../../../install/pipeline.zig").PackageResult,
    env_only_domains: *const env_deps.DomainSet,
) !void {
    return mergeCompanionLockfileEntriesUsingMetadata(allocator, lockfile, deps, results, env_only_domains, null);
}

fn mergeCompanionLockfileEntriesUsingMetadata(
    allocator: std.mem.Allocator,
    lockfile: *lib.packages.Lockfile,
    deps: []const @import("../../../deps/parser.zig").PackageDependency,
    results: []const @import("../../../install/pipeline.zig").PackageResult,
    env_only_domains: *const env_deps.DomainSet,
    metadata_origin: ?*const lib.packages.Lockfile,
) !void {
    // Packages whose resolved version depends on which platform installs them,
    // so the sweep below can tell a stale pin from another platform's.
    //
    // Seeded from `results` as well as the lockfile, and both halves are load
    // bearing. What the lockfile holds here is only what the workspace step
    // carried forward - the foreign pins themselves - and a foreign pin is a
    // leaf: nothing in that set declares the guard that makes it foreign. The
    // package that does declare it is the one this host just resolved, so it
    // arrives in `results` and nowhere else. Seeding from the lock alone left
    // `git-scm.org` out of the closure, which is the only package that says
    // `linux:gnu.org/gettext^0.21`, and gettext's Linux pin was then swept as
    // if it were stale.
    var foreign_seeds = std.ArrayList([]const u8).empty;
    defer foreign_seeds.deinit(allocator);
    {
        var seed_it = lockfile.packages.iterator();
        while (seed_it.next()) |entry| {
            if (native_lock.isNative(entry.value_ptr.*))
                try foreign_seeds.append(allocator, entry.value_ptr.name);
        }
        for (results) |result| {
            if (!result.success or result.name.len == 0) continue;
            const raw_name = helpers.normalizePackageName(result.name);
            const source = result.source orelse if (std.mem.indexOfScalar(u8, raw_name, '.') != null) lib.packages.PackageSource.pantry else lib.packages.PackageSource.npm;
            if (!native_identity.isNative(source)) continue;
            try foreign_seeds.append(allocator, native_identity.canonical(raw_name));
        }
    }
    var platform_pins = try @import("../../../install/pipeline.zig")
        .platformDependentClosure(allocator, foreign_seeds.items);
    defer platform_pins.deinit();

    // Record the requested constraints on the root workspace. This gives the
    // fast path a stable source-of-truth without discarding system deps declared
    // directly in package.json.
    if (lockfile.workspaces.getPtr("")) |root_workspace| {
        if (root_workspace.system == null)
            root_workspace.system = std.StringHashMap([]const u8).init(allocator);

        var system = &root_workspace.system.?;
        for (deps) |dep| {
            const clean_name = helpers.resolvePackageAlias(helpers.normalizePackageName(dep.name));
            if (!native_identity.isNative(helpers.effectiveDependencySource(dep))) continue;

            const owned_version = try allocator.dupe(u8, dep.version);
            if (system.getPtr(clean_name)) |existing_version| {
                allocator.free(existing_version.*);
                existing_version.* = owned_version;
            } else {
                try system.put(try allocator.dupe(u8, clean_name), owned_version);
            }
        }
    }

    for (results) |result| {
        if (!result.success or result.name.len == 0) continue;
        const raw_name = helpers.normalizePackageName(result.name);
        const source = result.source orelse if (std.mem.indexOfScalar(u8, raw_name, '.') != null) lib.packages.PackageSource.pantry else lib.packages.PackageSource.npm;
        const native = native_identity.isNative(source);
        const clean_name = if (native) native_identity.canonical(raw_name) else raw_name;
        if (native and env_only_domains.contains(clean_name)) continue;
        var selected = if (native) try native_lock.selectedEntry(allocator, metadata_origin orelse lockfile, clean_name, result.version, result.integrity) else lib.packages.LockfileEntry{
            .name = try allocator.dupe(u8, clean_name),
            .version = try allocator.dupe(u8, result.version),
            .source = source,
            .resolved = try std.fmt.allocPrint(allocator, "registry:{s}@{s}", .{ clean_name, result.version }),
            .integrity = if (result.integrity) |value| try allocator.dupe(u8, value) else null,
        };
        var transferred = false;
        defer if (!transferred) selected.deinit(allocator);

        // Replace every older pin for this package, regardless of its key's
        // version spelling (constraint or resolved version).
        var keys_to_remove = std.ArrayList([]const u8).empty;
        defer {
            for (keys_to_remove.items) |key| allocator.free(key);
            keys_to_remove.deinit(allocator);
        }

        var package_it = lockfile.packages.iterator();
        while (package_it.next()) |entry| {
            if (native) {
                if (!native_lock.isNative(entry.value_ptr.*) or !native_identity.same(entry.value_ptr.name, clean_name)) continue;
            } else if (!entry.value_ptr.matchesSource(source) or !std.mem.eql(u8, entry.value_ptr.name, clean_name)) continue;

            // Unless it is another platform's pin of the same package.
            //
            // Superseding an older pin is what this sweep is for. But two
            // platforms can legitimately need two versions: `git-scm.org`
            // declares `linux:gnu.org/gettext^0.21`, so gettext resolves to
            // 0.21.1 on Linux and to 1.0.0 on macOS, where that guard does not
            // apply and nothing else constrains it. Both are correct, the lock
            // keys by name@version so both fit, and removing by name alone
            // deleted whichever one the running host did not resolve - a lock
            // that cannot survive the trip to the other platform
            // (pantry-pm/pantry#231, #232).
            if (platform_pins.contains(native_identity.canonical(entry.value_ptr.name)) and !std.mem.eql(u8, entry.value_ptr.version, result.version)) continue;

            try keys_to_remove.append(allocator, try allocator.dupe(u8, entry.key_ptr.*));
        }

        for (keys_to_remove.items) |key| {
            if (lockfile.packages.fetchRemove(key)) |removed| {
                allocator.free(removed.key);
                var old_entry = removed.value;
                old_entry.deinit(allocator);
            }
        }

        const key = try std.fmt.allocPrint(allocator, "{s}@{s}", .{ clean_name, result.version });
        defer allocator.free(key);
        try lockfile.addEntry(allocator, key, selected);
        transferred = true;
    }
}

test "depDomainFromSpec keeps the version constraint its parent declares" {
    const t = std.testing;

    // A package links the library it was built against, so the closure must
    // install the declared version — resolving these to `latest` gave node v26
    // icu 78 / openssl 3.6 instead of the v73 / v1.1 it links, and node then
    // died on startup with a dyld "Library not loaded" error.
    const icu = depDomainFromSpec("unicode.org^73 # v25").?;
    try t.expectEqualStrings("unicode.org", icu.domain);
    try t.expectEqualStrings("^73", icu.constraint);

    // `@1.1` is the catalog's exact-pin spelling; the `@` is dropped so the
    // spec round-trips through the installer's `name@version` parsing.
    const ssl = depDomainFromSpec("openssl.org@1.1").?;
    try t.expectEqualStrings("openssl.org", ssl.domain);
    try t.expectEqualStrings("1.1", ssl.constraint);

    // An unconstrained dep stays unconstrained (resolves to latest).
    const pnpm = depDomainFromSpec("pnpm.io").?;
    try t.expectEqualStrings("pnpm.io", pnpm.domain);
    try t.expectEqualStrings("", pnpm.constraint);

    try t.expectEqualStrings(">=2.7", depDomainFromSpec("python.org>=2.7").?.constraint);
    try t.expectEqualStrings("~23.3", depDomainFromSpec("nodejs.org~23.3").?.constraint);

    // Platform-tagged pseudo-domains are not installable packages.
    try t.expect(depDomainFromSpec("darwin/x86-64") == null);
}

test "frozen resolution locks accept only the current resolved package" {
    const t = std.testing;
    const allocator = t.allocator;

    var lockfile = lib.deps.resolution.LockFile.init(allocator);
    defer lockfile.deinit();

    try lockfile.addPackage("bun.sh", "1.3.14", "registry:bun.sh@1.3.14", null);

    try t.expect(resolutionLockMatches(
        &lockfile,
        "bun.sh",
        "1.3.14",
        "registry:bun.sh@1.3.14",
    ));
    try t.expect(!resolutionLockMatches(
        &lockfile,
        "bun.sh",
        "1.3.15",
        "registry:bun.sh@1.3.15",
    ));
    try t.expect(!resolutionLockMatches(
        &lockfile,
        "nodejs.org",
        "24.0.0",
        "registry:nodejs.org@24.0.0",
    ));
}

test "companion deps replace stale system pins without dropping workspace packages" {
    const t = std.testing;
    const allocator = t.allocator;
    const parser = @import("../../../deps/parser.zig");
    const pipeline = @import("../../../install/pipeline.zig");

    var lockfile = try lib.packages.Lockfile.init(allocator, "1.0.0");
    defer lockfile.deinit(allocator);

    try lockfile.addWorkspace(allocator, "", .{
        .name = try allocator.dupe(u8, "fixture"),
        .system = blk: {
            var system = std.StringHashMap([]const u8).init(allocator);
            try system.put(try allocator.dupe(u8, "bun.sh"), try allocator.dupe(u8, "^1.3.4"));
            break :blk system;
        },
    });
    try lockfile.addWorkspace(allocator, "packages/ui", .{
        .name = try allocator.dupe(u8, "@fixture/ui"),
    });
    try lockfile.addEntry(allocator, "bun.sh@^1.3.4", .{
        .name = try allocator.dupe(u8, "bun.sh"),
        .version = try allocator.dupe(u8, "^1.3.4"),
        .source = .pantry,
    });
    try lockfile.addEntry(allocator, "lit@3.3.1", .{
        .name = try allocator.dupe(u8, "lit"),
        .version = try allocator.dupe(u8, "3.3.1"),
        .source = .npm,
    });

    const deps = [_]parser.PackageDependency{.{
        .name = "bun.sh",
        .version = "^1.3.14",
    }};
    const results = [_]pipeline.PackageResult{.{
        .name = "bun.sh",
        .version = "1.3.14",
        .success = true,
    }};

    var env_only = env_deps.DomainSet{ .allocator = allocator, .map = std.StringHashMap(void).init(allocator) };
    defer env_only.deinit();
    try mergeCompanionLockfileEntries(allocator, &lockfile, &deps, &results, &env_only);

    try t.expectEqualStrings("^1.3.14", lockfile.workspaces.get("").?.system.?.get("bun.sh").?);
    try t.expect(lockfile.packages.get("bun.sh@^1.3.4") == null);
    try t.expect(lockfile.packages.get("bun.sh@1.3.14") == null);
    try t.expectEqualStrings("1.3.14", lockfile.packages.get("bun.com@1.3.14").?.version);
    try t.expect(lockfile.packages.get("lit@3.3.1") != null);
    try t.expect(lockfile.workspaces.get("packages/ui") != null);
}

test "a service inferred from .env stays out of the lock, with what it pulled in" {
    const t = std.testing;
    const allocator = t.allocator;
    const parser = @import("../../../deps/parser.zig");
    const pipeline = @import("../../../install/pipeline.zig");

    var lockfile = try lib.packages.Lockfile.init(allocator, "1.0.0");
    defer lockfile.deinit(allocator);
    try lockfile.addWorkspace(allocator, "", .{ .name = try allocator.dupe(u8, "fixture") });

    // What the workspace declares. postgresql.org is not in it: `.env` said
    // DB_CONNECTION=postgres on the machine that ran this install.
    const declared = [_]parser.PackageDependency{.{ .name = "sqlite.org", .version = "^3" }};
    const inferred = [_]parser.PackageDependency{.{ .name = "postgresql.org", .version = "latest" }};

    // The pipeline installed all of it, postgres's own dependencies included.
    const results = [_]pipeline.PackageResult{
        .{ .name = "sqlite.org", .version = "3.51.0", .success = true },
        .{ .name = "postgresql.org", .version = "18.4.0", .success = true },
        .{ .name = "gnome.org/libxslt", .version = "1.1.45", .success = true },
        .{ .name = "unicode.org", .version = "73.2.0", .success = true },
    };

    var env_only = try env_deps.inferredOnlyDomains(allocator, &inferred, &declared);
    defer env_only.deinit();
    try mergeCompanionLockfileEntries(allocator, &lockfile, &declared, &results, &env_only);

    // The declared package is locked, as always.
    try t.expectEqualStrings("3.51.0", lockfile.packages.get("sqlite.org@3.51.0").?.version);
    try t.expectEqualStrings("^3", lockfile.workspaces.get("").?.system.?.get("sqlite.org").?);

    // The three entries the reported lock gained are absent, as is the
    // constraint that put "postgresql.org": "latest" on the root workspace —
    // so this lock is byte-identical to one cut on a machine whose .env says
    // sqlite (#253).
    try t.expect(lockfile.packages.get("postgresql.org@18.4.0") == null);
    try t.expect(lockfile.packages.get("gnome.org/libxslt@1.1.45") == null);
    try t.expect(lockfile.packages.get("unicode.org@73.2.0") == null);
    try t.expect(lockfile.workspaces.get("").?.system.?.get("postgresql.org") == null);
}

test "a manifest install fails when a package it asked for did not arrive" {
    // The bug this pins: this path returned 0 unconditionally while every other
    // install path returned 1, so `pantry install` printed "1 package(s) failed
    // to install" in red and told its caller everything was fine. Scripts
    // shaped like `pantry install && build` then built without the dependency.
    try std.testing.expectEqual(@as(u8, 1), manifestExitCode(1));
    try std.testing.expectEqual(@as(u8, 1), manifestExitCode(9));
}

test "and succeeds when nothing failed" {
    // Including the two cases that are not installs at all: everything already
    // present, and a manifest with no dependencies. Both count zero failures.
    try std.testing.expectEqual(@as(u8, 0), manifestExitCode(0));
}

test "isExactVersion separates a pin from a range" {
    const t = std.testing;

    // Exact: these skip the Pantry registry, which would answer with whatever
    // version it holds rather than the one asked for.
    try t.expect(isExactVersion("1.2.0"));
    try t.expect(isExactVersion("0.72.34"));
    try t.expect(isExactVersion("9.2.0-rc1"));

    // Ranges and tags are not pins. Routing one to npm looks the string up as a
    // key in `versions`, where `^1.2.0` is not, so the install fails outright -
    // which is how a caret range stopped installing in 0.11.37.
    try t.expect(!isExactVersion("^1.2.0"));
    try t.expect(!isExactVersion("~1.3"));
    try t.expect(!isExactVersion(">=1.2.0"));
    try t.expect(!isExactVersion("1.x"));
    try t.expect(!isExactVersion("1.2.0 || 1.3.0"));
    try t.expect(!isExactVersion("*"));
    try t.expect(!isExactVersion("latest"));
    try t.expect(!isExactVersion(""));
}

test "a Pantry registry that gates a name ends the lookup instead of falling back to npm" {
    const t = std.testing;
    // 401/402/403: the name is the registry's own. Each is an error, so the
    // named install stops rather than asking npm about the same name.
    try t.expectEqual(@as(?anyerror, error.RegistryAuthenticationRequired), helpers.gatedStatusError(401));
    try t.expectEqual(@as(?anyerror, error.PaymentRequired), helpers.gatedStatusError(402));
    try t.expectEqual(@as(?anyerror, error.RegistryAccessDenied), helpers.gatedStatusError(403));
    // A miss, an outage or a success is not a gate.
    try t.expect(helpers.gatedStatusError(200) == null);
    try t.expect(helpers.gatedStatusError(404) == null);
    try t.expect(helpers.gatedStatusError(503) == null);

    const message = helpers.gatedLookupMessage(t.allocator, error.RegistryAccessDenied, "@acme/sdk", "1.0.0").?;
    defer t.allocator.free(message);
    try t.expect(std.mem.indexOf(u8, message, "(403)") != null);
    try t.expect(helpers.gatedLookupMessage(t.allocator, error.FileNotFound, "x", "1") == null);
}

test "a frozen install refuses a changed integrity and accepts a first one" {
    const t = std.testing;
    var lock = lib.deps.resolution.LockFile.init(t.allocator);
    defer lock.deinit();
    const recorded = "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    try lock.addPackage("@hq/platform", "1.4.0", "registry:@hq/platform@1.4.0", recorded);
    try lock.addPackage("legacy", "1.0.0", "registry:legacy@1.0.0", null);

    try t.expect(lockIntegrityMatches(&lock, "@hq/platform", recorded));
    try t.expect(lockIntegrityMatches(&lock, "@hq/platform", null));
    try t.expect(!lockIntegrityMatches(&lock, "@hq/platform", "sha256:0000000000000000000000000000000000000000000000000000000000000000"));
    // An entry from before integrity was recorded takes the first one.
    try t.expect(lockIntegrityMatches(&lock, "legacy", recorded));
}

test "an unpinned 402 repeats what the registry said instead of a credential hint" {
    const t = std.testing;
    // The lookup records the 402 body; the message the install prints uses it.
    helpers.rememberGatedPaymentForTest("@hq/platform costs $9.00. Buy it with: pantry buy @hq/platform (or open https://registry.pantry.dev/packages/%40hq%2Fplatform/buy)");
    const message = helpers.gatedLookupMessage(t.allocator, error.PaymentRequired, "@hq/platform", "1.4.0").?;
    defer t.allocator.free(message);
    try t.expect(std.mem.startsWith(u8, message, "@hq/platform costs $9.00. Buy it with: pantry buy @hq/platform"));
    try t.expect(std.mem.indexOf(u8, message, "PANTRY_REGISTRY_TOKEN") == null);

    // Taken once: the next gated message without a 402 body is the generic one.
    const generic = helpers.gatedLookupMessage(t.allocator, error.PaymentRequired, "@hq/platform", "1.4.0").?;
    defer t.allocator.free(generic);
    try t.expect(std.mem.indexOf(u8, generic, "is a paid package") != null);
}

test "named native discovery keeps sibling constraints under both root orders" {
    const allocator = std.testing.allocator;
    const semver = @import("../../../packages/semver.zig");
    const NoMetadata = struct {
        fn lookup(_: std.mem.Allocator, _: []const u8, _: []const u8) ![]const u8 {
            return error.UnexpectedMetadataLookup;
        }
    };
    for ([_]bool{ false, true }) |reverse| {
        var requests: std.ArrayList(NamedInstallRequest) = .empty;
        defer {
            for (requests.items) |*request| request.deinit(allocator);
            requests.deinit(allocator);
        }
        const roots = [_]lib.packages.PackageSpec{ .{ .name = "facebook.com/zstd", .version = "1.5.7", .source = .pantry }, .{ .name = "lz4.org", .version = "1.10.0", .source = .pantry } };
        for (0..roots.len) |index| {
            const spec = roots[if (reverse) roots.len - index - 1 else index];
            try appendNamedRequest(allocator, &requests, spec, spec.version, true, null);
        }
        var plan = try collectNamedNativePlan(allocator, requests.items);
        defer plan.deinit();
        var original = lib.deps.resolution.LockFile.init(allocator);
        defer original.deinit();
        for (plan.names.items) |name| {
            const entry = plan.entries.get(name).?;
            const pin = if (std.mem.eql(u8, name, "lz4.org")) "1.10.0" else semver.resolveVersion(name, entry.constraints.items[0]) orelse return error.MissingCatalogFixtureVersion;
            try original.addPackage(name, pin, "registry:fixture", null);
        }
        try plan.resolveUsing(.{ .original_lock = &original, .frozen = true }, NoMetadata.lookup);
        try std.testing.expectEqualStrings("1.10.0", try plan.versionFor("lz4.org", "^1"));
        try std.testing.expectEqualStrings("1.10.0", try plan.versionFor("lz4.org", "1.10.0"));
        try appendNamedRequest(allocator, &requests, .{ .name = "lz4.org", .version = "^2", .source = .pantry }, "^2", true, null);
        var incompatible = try collectNamedNativePlan(allocator, requests.items);
        defer incompatible.deinit();
        try std.testing.expectError(error.NativeLockNotSatisfied, incompatible.resolveUsing(.{ .original_lock = &original, .frozen = true }, NoMetadata.lookup));
    }
}

test "named native authored ranges retain normal pins and force still obeys frozen coverage" {
    const allocator = std.testing.allocator;
    const Metadata = struct {
        fn lookup(a: std.mem.Allocator, _: []const u8, constraint: []const u8) ![]const u8 {
            const parsed = try std.json.parseFromSlice(std.json.Value, a,
                \\{"1.10.0":{"platforms":{"fixture":{"tarball":"old","sha256":"a","size":1}}},"1.11.0":{"platforms":{"fixture":{"tarball":"new","sha256":"b","size":1}}}}
            , .{});
            defer parsed.deinit();
            const selected = @import("../../../install/registry_versions.zig").select(parsed.value.object, constraint, "fixture") orelse return error.NativeConstraintConflict;
            return a.dupe(u8, selected.version);
        }
    };
    var requests: std.ArrayList(NamedInstallRequest) = .empty;
    defer {
        for (requests.items) |*request| request.deinit(allocator);
        requests.deinit(allocator);
    }
    try appendNamedRequest(allocator, &requests, .{ .name = "lz4.org", .version = "^1", .source = .pantry }, "^1", true, null);
    var original = lib.deps.resolution.LockFile.init(allocator);
    defer original.deinit();
    try original.addPackage("lz4.org", "1.10.0", "registry:lz4.org@1.10.0", null);
    for ([_]bool{ false, true }) |force| {
        var plan = try collectNamedNativePlan(allocator, requests.items);
        defer plan.deinit();
        try plan.resolveUsing(.{ .original_lock = &original, .force = force }, Metadata.lookup);
        try std.testing.expectEqualStrings(if (force) "1.11.0" else "1.10.0", try plan.versionFor("lz4.org", "^1"));
    }
    var frozen = try collectNamedNativePlan(allocator, requests.items);
    defer frozen.deinit();
    try std.testing.expectError(error.NativeLockNotSatisfied, frozen.resolveUsing(.{ .original_lock = &original, .frozen = true, .force = true }, Metadata.lookup));
    try std.testing.expectError(error.NativePlanNotResolved, frozen.versionFor("lz4.org", "^1"));
}

test "auto npm preference defers identity ambiguity and explicit non-native behavior remains generic" {
    const allocator = std.testing.allocator;
    var original = try lib.deps.resolution.LockFile.parse(allocator,
        \\{"packages":{"fixture@1.0.0":{"name":"fixture","version":"1.0.0","source":"npm"},"fixture@1.1.0":{"name":"fixture","version":"1.1.0","source":"pantry"}}}
    );
    defer original.deinit();
    try std.testing.expectEqualStrings("1.0.0", (try preferredPipelineVersion(&original, .{ .name = "fixture", .version = "^1", .source = .registry })).?);
    try std.testing.expectError(error.AmbiguousLockedVersion, preferredPipelineVersion(&original, .{ .name = "fixture", .version = "^1", .source = .npm }));
}

test "named discovery preserves locked native provider identity independently of range selection" {
    const allocator = std.testing.allocator;
    var original = try lib.deps.resolution.LockFile.parse(allocator,
        \\{"packages":{"first.example@1.0.0":{"name":"first.example","version":"1.0.0","source":"pantry"},"bun.sh@1.4.3":{"name":"bun.sh","version":"1.4.3","source":"pantry"},"npm.example@1.0.0":{"name":"npm.example","version":"1.0.0","source":"npm"}}}
    );
    defer original.deinit();
    try std.testing.expect(hasNativeLockIdentity(&original, "first.example"));
    try std.testing.expect(hasNativeLockIdentity(&original, "bun.com"));
    try std.testing.expect(!hasNativeLockIdentity(&original, "npm.example"));
    try std.testing.expect(!hasNativeLockIdentity(&original, "missing.example"));
}
