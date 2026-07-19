//! Publish Commit Command Tests
//!
//! Tests for the commit-based publishing functionality (pkg-pr-new equivalent).
//! Tests the package name sanitization, S3 key generation, DynamoDB key format,
//! and version comparison logic.

const std = @import("std");
const testing = std.testing;
const lib = @import("lib");

// ============================================================================
// Package Name Sanitization Tests
// ============================================================================

test "sanitize package name for S3 key" {
    // Test sanitization logic used in commit publishing
    const names = [_]struct { input: []const u8, expected: []const u8 }{
        .{ .input = "simple-pkg", .expected = "simple-pkg" },
        .{ .input = "@scope/name", .expected = "scope-name" },
        .{ .input = "@stacksjs/actions", .expected = "stacksjs-actions" },
        .{ .input = "no-scope", .expected = "no-scope" },
    };

    for (names) |case| {
        var sanitized: [256]u8 = undefined;
        for (case.input, 0..) |c, i| {
            sanitized[i] = if (c == '@' or c == '/') '-' else c;
        }
        const result = sanitized[0..case.input.len];
        const clean = if (result[0] == '-') result[1..] else result;
        try testing.expectEqualStrings(case.expected, clean);
    }
}

// ============================================================================
// S3 Key Generation Tests
// ============================================================================

test "commit S3 key format is correct" {
    const allocator = testing.allocator;

    // Verify the key format: commits/{sha}/{safeName}/{safeName}.tgz
    const sha = "abc1234567890def";
    const name = "@stacksjs/actions";

    // Sanitize
    var sanitized_name = try allocator.alloc(u8, name.len);
    defer allocator.free(sanitized_name);
    for (name, 0..) |c, i| {
        sanitized_name[i] = if (c == '@' or c == '/') '-' else c;
    }
    const clean_name = if (sanitized_name[0] == '-') sanitized_name[1..] else sanitized_name;

    const key = try std.fmt.allocPrint(allocator, "commits/{s}/{s}/{s}.tgz", .{ sha, clean_name, clean_name });
    defer allocator.free(key);

    try testing.expectEqualStrings("commits/abc1234567890def/stacksjs-actions/stacksjs-actions.tgz", key);
}

test "commit install URL format is correct" {
    const allocator = testing.allocator;

    const registry = "https://registry.pantry.dev";
    const sha = "abc1234";
    const name = "@stacksjs/actions";

    const url = try std.fmt.allocPrint(allocator, "{s}/commits/{s}/{s}/tarball", .{ registry, sha, name });
    defer allocator.free(url);

    try testing.expectEqualStrings("https://registry.pantry.dev/commits/abc1234/@stacksjs/actions/tarball", url);
}

// ============================================================================
// DynamoDB Key Format Tests
// ============================================================================

test "commit DynamoDB PK/SK format" {
    const allocator = testing.allocator;

    const sha = "abc1234";
    const name = "my-package";

    // Primary key format
    const pk = try std.fmt.allocPrint(allocator, "COMMIT#{s}", .{sha});
    defer allocator.free(pk);
    const sk = try std.fmt.allocPrint(allocator, "PACKAGE#{s}", .{name});
    defer allocator.free(sk);

    try testing.expectEqualStrings("COMMIT#abc1234", pk);
    try testing.expectEqualStrings("PACKAGE#my-package", sk);

    // Reverse lookup
    const rev_pk = try std.fmt.allocPrint(allocator, "COMMIT_PACKAGE#{s}", .{name});
    defer allocator.free(rev_pk);
    const rev_sk = try std.fmt.allocPrint(allocator, "SHA#{s}", .{sha});
    defer allocator.free(rev_sk);

    try testing.expectEqualStrings("COMMIT_PACKAGE#my-package", rev_pk);
    try testing.expectEqualStrings("SHA#abc1234", rev_sk);
}

// ============================================================================
// Version Extraction Tests
// ============================================================================

test "version comparison for semver" {
    // Test isLowerVersion logic — same as registry.zig
    const cases = [_]struct { v1: []const u8, v2: []const u8, expected: bool }{
        .{ .v1 = "1.0.0", .v2 = "2.0.0", .expected = true },
        .{ .v1 = "2.0.0", .v2 = "1.0.0", .expected = false },
        .{ .v1 = "1.1.0", .v2 = "1.2.0", .expected = true },
        .{ .v1 = "1.2.0", .v2 = "1.1.0", .expected = false },
        .{ .v1 = "1.0.1", .v2 = "1.0.2", .expected = true },
        .{ .v1 = "1.0.0", .v2 = "1.0.0", .expected = false },
    };

    for (cases) |case| {
        var v1_parts = std.mem.splitScalar(u8, case.v1, '.');
        var v2_parts = std.mem.splitScalar(u8, case.v2, '.');

        var result = false;
        inline for (0..3) |_| {
            const p1_str = v1_parts.next() orelse "0";
            const p2_str = v2_parts.next() orelse "0";
            const p1 = std.fmt.parseInt(u32, p1_str, 10) catch 0;
            const p2 = std.fmt.parseInt(u32, p2_str, 10) catch 0;
            if (p1 < p2) {
                result = true;
                break;
            }
            if (p1 > p2) {
                result = false;
                break;
            }
        }

        try testing.expectEqual(case.expected, result);
    }
}

// ============================================================================
// Monorepo Detection Tests (uses registry_commands.detectMonorepoPackages)
// ============================================================================

test "detectMonorepoPackages finds packages in packages/ directory" {
    const allocator = testing.allocator;
    const io_helper = lib.io_helper;

    const tmp_dir = "test_data_pc_monorepo";
    defer io_helper.deleteTree(tmp_dir) catch {};

    const packages_dir = try std.fs.path.join(allocator, &[_][]const u8{ tmp_dir, "packages" });
    defer allocator.free(packages_dir);
    try io_helper.makePath(packages_dir);

    // Create pkg-a
    const dir_a = try std.fs.path.join(allocator, &[_][]const u8{ packages_dir, "pkg-a" });
    defer allocator.free(dir_a);
    try io_helper.makePath(dir_a);
    {
        const cfg = try std.fs.path.join(allocator, &[_][]const u8{ dir_a, "package.json" });
        defer allocator.free(cfg);
        const file = try io_helper.cwd().createFile(io_helper.io, cfg, .{});
        defer file.close(io_helper.io);
        try io_helper.writeAllToFile(file, "{\"name\": \"pkg-a\", \"version\": \"1.0.0\"}");
    }

    // Create pkg-b
    const dir_b = try std.fs.path.join(allocator, &[_][]const u8{ packages_dir, "pkg-b" });
    defer allocator.free(dir_b);
    try io_helper.makePath(dir_b);
    {
        const cfg = try std.fs.path.join(allocator, &[_][]const u8{ dir_b, "package.json" });
        defer allocator.free(cfg);
        const file = try io_helper.cwd().createFile(io_helper.io, cfg, .{});
        defer file.close(io_helper.io);
        try io_helper.writeAllToFile(file, "{\"name\": \"pkg-b\", \"version\": \"2.0.0\"}");
    }

    // Create private-pkg
    const dir_priv = try std.fs.path.join(allocator, &[_][]const u8{ packages_dir, "private-pkg" });
    defer allocator.free(dir_priv);
    try io_helper.makePath(dir_priv);
    {
        const cfg = try std.fs.path.join(allocator, &[_][]const u8{ dir_priv, "package.json" });
        defer allocator.free(cfg);
        const file = try io_helper.cwd().createFile(io_helper.io, cfg, .{});
        defer file.close(io_helper.io);
        try io_helper.writeAllToFile(file, "{\"name\": \"private-pkg\", \"version\": \"0.1.0\", \"private\": true}");
    }

    // Detect packages
    const result = try lib.commands.registry_commands.detectMonorepoPackages(allocator, tmp_dir, null);
    defer if (result) |pkgs| {
        for (pkgs) |*pkg| {
            var p = pkg.*;
            p.deinit(allocator);
        }
        allocator.free(pkgs);
    };

    try testing.expect(result != null);
    const pkgs = result.?;

    // Should find 2 non-private packages
    try testing.expectEqual(@as(usize, 2), pkgs.len);

    // Verify package names (order may vary)
    var found_a = false;
    var found_b = false;
    for (pkgs) |pkg| {
        if (std.mem.eql(u8, pkg.name, "pkg-a")) found_a = true;
        if (std.mem.eql(u8, pkg.name, "pkg-b")) found_b = true;
    }
    try testing.expect(found_a);
    try testing.expect(found_b);
}

test "detectMonorepoPackages returns null when no packages/ dir" {
    const allocator = testing.allocator;
    const io_helper = lib.io_helper;

    const tmp_dir = "test_data_pc_no_monorepo";
    try io_helper.makePath(tmp_dir);
    defer io_helper.deleteTree(tmp_dir) catch {};

    const result = try lib.commands.registry_commands.detectMonorepoPackages(allocator, tmp_dir, null);
    try testing.expect(result == null);
}

test "detectMonorepoPackages respects skip flag" {
    const allocator = testing.allocator;
    const io_helper = lib.io_helper;

    const tmp_dir = "test_data_pc_skip";
    defer io_helper.deleteTree(tmp_dir) catch {};

    const packages_dir = try std.fs.path.join(allocator, &[_][]const u8{ tmp_dir, "packages" });
    defer allocator.free(packages_dir);
    try io_helper.makePath(packages_dir);

    // Create keep-me
    const dir_a = try std.fs.path.join(allocator, &[_][]const u8{ packages_dir, "keep-me" });
    defer allocator.free(dir_a);
    try io_helper.makePath(dir_a);
    {
        const cfg = try std.fs.path.join(allocator, &[_][]const u8{ dir_a, "package.json" });
        defer allocator.free(cfg);
        const file = try io_helper.cwd().createFile(io_helper.io, cfg, .{});
        defer file.close(io_helper.io);
        try io_helper.writeAllToFile(file, "{\"name\": \"keep-me\", \"version\": \"1.0.0\"}");
    }

    // Create skip-me
    const dir_b = try std.fs.path.join(allocator, &[_][]const u8{ packages_dir, "skip-me" });
    defer allocator.free(dir_b);
    try io_helper.makePath(dir_b);
    {
        const cfg = try std.fs.path.join(allocator, &[_][]const u8{ dir_b, "package.json" });
        defer allocator.free(cfg);
        const file = try io_helper.cwd().createFile(io_helper.io, cfg, .{});
        defer file.close(io_helper.io);
        try io_helper.writeAllToFile(file, "{\"name\": \"skip-me\", \"version\": \"1.0.0\"}");
    }

    // Skip "skip-me"
    const result = try lib.commands.registry_commands.detectMonorepoPackages(allocator, tmp_dir, "skip-me");
    defer if (result) |pkgs| {
        for (pkgs) |*pkg| {
            var p = pkg.*;
            p.deinit(allocator);
        }
        allocator.free(pkgs);
    };

    try testing.expect(result != null);
    try testing.expectEqual(@as(usize, 1), result.?.len);
    try testing.expectEqualStrings("keep-me", result.?[0].name);
}

// ============================================================================
// npm publish target selection (native vs JS packages)
// ============================================================================

test "npmSkipReason: native packages skip npm, explicit pantry.npm overrides" {
    const io_helper = lib.io_helper;
    const npmSkipReason = lib.commands.package_commands.npmSkipReason;
    const allocator = testing.allocator;

    const ts = io_helper.clockGettime();
    const dir = try std.fmt.allocPrint(allocator, "/tmp/pantry-npmskip-{d}", .{@as(u64, @intCast(ts.sec)) * 1_000_000 + @as(u64, @intCast(@divFloor(ts.nsec, 1000)))});
    defer allocator.free(dir);
    try io_helper.makePath(dir);
    defer io_helper.deleteTree(dir) catch {};

    const cfg = try std.fs.path.join(allocator, &[_][]const u8{ dir, "package.json" });
    defer allocator.free(cfg);
    const build_zig = try std.fs.path.join(allocator, &[_][]const u8{ dir, "build.zig" });
    defer allocator.free(build_zig);

    const write = struct {
        fn f(path: []const u8, data: []const u8) !void {
            const io_h = lib.io_helper;
            const file = try io_h.cwd().createFile(io_h.io, path, .{});
            defer file.close(io_h.io);
            try io_h.writeAllToFile(file, data);
        }
    }.f;

    // Plain JS package → publishes to npm (no skip reason).
    try write(cfg, "{\"name\":\"js\",\"version\":\"1.0.0\"}");
    try testing.expect(npmSkipReason(allocator, dir, cfg) == null);

    // A build.zig makes it a native package → skipped.
    try write(build_zig, "pub fn build() void {}");
    try testing.expect(npmSkipReason(allocator, dir, cfg) != null);

    // Explicit opt-in overrides the native auto-detection.
    try write(cfg, "{\"name\":\"z\",\"version\":\"1.0.0\",\"pantry\":{\"npm\":true}}");
    try testing.expect(npmSkipReason(allocator, dir, cfg) == null);

    // Explicit opt-out skips even a plain JS package.
    io_helper.deleteFile(build_zig) catch {};
    try write(cfg, "{\"name\":\"j\",\"version\":\"1.0.0\",\"pantry\":{\"npm\":false}}");
    try testing.expect(npmSkipReason(allocator, dir, cfg) != null);
}

// ============================================================================
// Workspace Protocol Rewrite Tests
//
// `pantry publish` / `pantry publish:commit` must rewrite workspace: ranges
// in the staged manifest (bun publish semantics) and fail loudly when a
// range cannot be resolved from the workspace's own packages.
// ============================================================================

const workspace_publish = lib.commands.workspace_publish;

const ws_io = lib.io_helper;

fn writeTestFile(path: []const u8, content: []const u8) !void {
    const file = try ws_io.createFile(path, .{});
    defer file.close(ws_io.io);
    try ws_io.writeAllToFile(file, content);
}

fn makeTestDir(allocator: std.mem.Allocator, comptime prefix: []const u8) ![]const u8 {
    const ts = ws_io.clockGettime();
    const dir = try std.fmt.allocPrint(allocator, "/tmp/" ++ prefix ++ "-{d}", .{@as(u64, @intCast(ts.sec)) * 1_000_000 + @as(u64, @intCast(@divFloor(ts.nsec, 1000)))});
    try ws_io.makePath(dir);
    return dir;
}

/// Build a workspace fixture: root package.json with `workspaces: ["packages/*"]`,
/// `packages/core` (@ws/core@0.2.9) and `packages/app`.
fn makeWorkspaceFixture(allocator: std.mem.Allocator) ![]const u8 {
    const root = try makeTestDir(allocator, "pantry-wsproto");
    errdefer ws_io.deleteTree(root) catch {};

    const root_pkg = try std.fs.path.join(allocator, &[_][]const u8{ root, "package.json" });
    defer allocator.free(root_pkg);
    try writeTestFile(root_pkg,
        \\{
        \\  "name": "ws-root",
        \\  "private": true,
        \\  "workspaces": ["packages/*"]
        \\}
    );

    const core_dir = try std.fs.path.join(allocator, &[_][]const u8{ root, "packages", "core" });
    defer allocator.free(core_dir);
    try ws_io.makePath(core_dir);
    const core_pkg = try std.fs.path.join(allocator, &[_][]const u8{ core_dir, "package.json" });
    defer allocator.free(core_pkg);
    try writeTestFile(core_pkg,
        \\{
        \\  "name": "@ws/core",
        \\  "version": "0.2.9"
        \\}
    );

    const app_dir = try std.fs.path.join(allocator, &[_][]const u8{ root, "packages", "app" });
    defer allocator.free(app_dir);
    try ws_io.makePath(app_dir);

    return root;
}

fn appDir(allocator: std.mem.Allocator, root: []const u8) ![]const u8 {
    return std.fs.path.join(allocator, &[_][]const u8{ root, "packages", "app" });
}

fn expectDepRange(allocator: std.mem.Allocator, content: []const u8, section: []const u8, dep: []const u8, expected: []const u8) !void {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, content, .{});
    defer parsed.deinit();
    const deps = parsed.value.object.get(section) orelse return error.TestExpectedSection;
    const range = deps.object.get(dep) orelse return error.TestExpectedDep;
    try testing.expectEqualStrings(expected, range.string);
}

test "workspace protocol rewrite - workspace:* resolves to exact version" {
    const allocator = testing.allocator;
    const root = try makeWorkspaceFixture(allocator);
    defer allocator.free(root);
    defer ws_io.deleteTree(root) catch {};
    const app_dir = try appDir(allocator, root);
    defer allocator.free(app_dir);

    const content =
        \\{
        \\  "name": "@ws/app",
        \\  "version": "1.0.0",
        \\  "dependencies": { "@ws/core": "workspace:*" }
        \\}
    ;

    const rewritten = try workspace_publish.rewriteManifestContent(allocator, content, app_dir);
    try testing.expect(rewritten.ptr != content.ptr);
    defer allocator.free(rewritten);

    try expectDepRange(allocator, rewritten, "dependencies", "@ws/core", "0.2.9");
}

test "workspace protocol rewrite - caret and tilde variants" {
    const allocator = testing.allocator;
    const root = try makeWorkspaceFixture(allocator);
    defer allocator.free(root);
    defer ws_io.deleteTree(root) catch {};
    const app_dir = try appDir(allocator, root);
    defer allocator.free(app_dir);

    const content =
        \\{
        \\  "name": "@ws/app",
        \\  "version": "1.0.0",
        \\  "dependencies": { "@ws/core": "workspace:^" },
        \\  "devDependencies": { "@ws/core": "workspace:~" }
        \\}
    ;

    const rewritten = try workspace_publish.rewriteManifestContent(allocator, content, app_dir);
    defer allocator.free(rewritten);

    try expectDepRange(allocator, rewritten, "dependencies", "@ws/core", "^0.2.9");
    try expectDepRange(allocator, rewritten, "devDependencies", "@ws/core", "~0.2.9");
}

test "workspace protocol rewrite - bare workspace: resolves to exact version" {
    const allocator = testing.allocator;
    const root = try makeWorkspaceFixture(allocator);
    defer allocator.free(root);
    defer ws_io.deleteTree(root) catch {};
    const app_dir = try appDir(allocator, root);
    defer allocator.free(app_dir);

    const content =
        \\{
        \\  "dependencies": { "@ws/core": "workspace:" }
        \\}
    ;

    const rewritten = try workspace_publish.rewriteManifestContent(allocator, content, app_dir);
    defer allocator.free(rewritten);

    try expectDepRange(allocator, rewritten, "dependencies", "@ws/core", "0.2.9");
}

test "workspace protocol rewrite - explicit range keeps range, drops prefix" {
    const allocator = testing.allocator;
    const root = try makeWorkspaceFixture(allocator);
    defer allocator.free(root);
    defer ws_io.deleteTree(root) catch {};
    const app_dir = try appDir(allocator, root);
    defer allocator.free(app_dir);

    const content =
        \\{
        \\  "dependencies": { "@ws/core": "workspace:^1.0.0" }
        \\}
    ;

    const rewritten = try workspace_publish.rewriteManifestContent(allocator, content, app_dir);
    defer allocator.free(rewritten);

    try expectDepRange(allocator, rewritten, "dependencies", "@ws/core", "^1.0.0");
}

test "workspace protocol rewrite - all dependency sections are covered" {
    const allocator = testing.allocator;
    const root = try makeWorkspaceFixture(allocator);
    defer allocator.free(root);
    defer ws_io.deleteTree(root) catch {};
    const app_dir = try appDir(allocator, root);
    defer allocator.free(app_dir);

    const content =
        \\{
        \\  "dependencies": { "@ws/core": "workspace:*" },
        \\  "devDependencies": { "@ws/core": "workspace:*" },
        \\  "peerDependencies": { "@ws/core": "workspace:^" },
        \\  "optionalDependencies": { "@ws/core": "workspace:~" }
        \\}
    ;

    const rewritten = try workspace_publish.rewriteManifestContent(allocator, content, app_dir);
    defer allocator.free(rewritten);

    try expectDepRange(allocator, rewritten, "dependencies", "@ws/core", "0.2.9");
    try expectDepRange(allocator, rewritten, "devDependencies", "@ws/core", "0.2.9");
    try expectDepRange(allocator, rewritten, "peerDependencies", "@ws/core", "^0.2.9");
    try expectDepRange(allocator, rewritten, "optionalDependencies", "@ws/core", "~0.2.9");
}

test "workspace protocol rewrite - non-workspace ranges stay untouched" {
    const allocator = testing.allocator;
    const root = try makeWorkspaceFixture(allocator);
    defer allocator.free(root);
    defer ws_io.deleteTree(root) catch {};
    const app_dir = try appDir(allocator, root);
    defer allocator.free(app_dir);

    const content =
        \\{
        \\  "dependencies": {
        \\    "@ws/core": "workspace:*",
        \\    "left-pad": "^1.3.0",
        \\    "local-thing": "file:../local-thing"
        \\  }
        \\}
    ;

    const rewritten = try workspace_publish.rewriteManifestContent(allocator, content, app_dir);
    defer allocator.free(rewritten);

    try expectDepRange(allocator, rewritten, "dependencies", "@ws/core", "0.2.9");
    try expectDepRange(allocator, rewritten, "dependencies", "left-pad", "^1.3.0");
    try expectDepRange(allocator, rewritten, "dependencies", "local-thing", "file:../local-thing");
}

test "workspace protocol rewrite - manifest without workspace refs is returned as-is" {
    const allocator = testing.allocator;

    const content =
        \\{
        \\  "dependencies": { "left-pad": "^1.3.0" }
        \\}
    ;

    const rewritten = try workspace_publish.rewriteManifestContent(allocator, content, "/tmp");
    try testing.expect(rewritten.ptr == content.ptr);
}

test "workspace protocol rewrite - unresolvable dependency fails loudly" {
    const allocator = testing.allocator;
    const root = try makeWorkspaceFixture(allocator);
    defer allocator.free(root);
    defer ws_io.deleteTree(root) catch {};
    const app_dir = try appDir(allocator, root);
    defer allocator.free(app_dir);

    const content =
        \\{
        \\  "dependencies": { "@ws/missing": "workspace:*" }
        \\}
    ;

    try testing.expectError(
        error.UnresolvableWorkspaceDependency,
        workspace_publish.rewriteManifestContent(allocator, content, app_dir),
    );
}

test "workspace protocol rewrite - workspace package without version fails loudly" {
    const allocator = testing.allocator;
    const root = try makeTestDir(allocator, "pantry-wsproto-nover");
    defer allocator.free(root);
    defer ws_io.deleteTree(root) catch {};

    const root_pkg = try std.fs.path.join(allocator, &[_][]const u8{ root, "package.json" });
    defer allocator.free(root_pkg);
    try writeTestFile(root_pkg,
        \\{
        \\  "name": "ws-root",
        \\  "private": true,
        \\  "workspaces": ["packages/*"]
        \\}
    );

    const core_dir = try std.fs.path.join(allocator, &[_][]const u8{ root, "packages", "core" });
    defer allocator.free(core_dir);
    try ws_io.makePath(core_dir);
    const core_pkg = try std.fs.path.join(allocator, &[_][]const u8{ core_dir, "package.json" });
    defer allocator.free(core_pkg);
    try writeTestFile(core_pkg,
        \\{
        \\  "name": "@ws/core"
        \\}
    );

    const app_dir = try appDir(allocator, root);
    defer allocator.free(app_dir);
    try ws_io.makePath(app_dir);

    const content =
        \\{
        \\  "dependencies": { "@ws/core": "workspace:*" }
        \\}
    ;

    try testing.expectError(
        error.UnresolvableWorkspaceDependency,
        workspace_publish.rewriteManifestContent(allocator, content, app_dir),
    );
}

test "workspace protocol rewrite - no workspace root fails loudly" {
    const allocator = testing.allocator;
    const dir = try makeTestDir(allocator, "pantry-wsproto-noroot");
    defer allocator.free(dir);
    defer ws_io.deleteTree(dir) catch {};

    const content =
        \\{
        \\  "dependencies": { "@ws/core": "workspace:*" }
        \\}
    ;

    try testing.expectError(
        error.UnresolvableWorkspaceDependency,
        workspace_publish.rewriteManifestContent(allocator, content, dir),
    );
}

test "workspace discovery - findWorkspaceRoot and resolveWorkspacePackages" {
    const allocator = testing.allocator;
    const root = try makeWorkspaceFixture(allocator);
    defer allocator.free(root);
    defer ws_io.deleteTree(root) catch {};
    const app_dir = try appDir(allocator, root);
    defer allocator.free(app_dir);

    const found_root = workspace_publish.findWorkspaceRoot(allocator, app_dir) orelse return error.TestExpectedWorkspaceRoot;
    defer allocator.free(found_root);
    try testing.expectEqualStrings(root, found_root);

    var packages = try workspace_publish.resolveWorkspacePackages(allocator, root);
    defer workspace_publish.freeWorkspacePackages(allocator, &packages);

    try testing.expectEqualStrings("0.2.9", packages.get("@ws/core").?);
}

test "workspace protocol rewrite - staged manifest rewritten, on-disk source untouched" {
    const allocator = testing.allocator;
    const root = try makeWorkspaceFixture(allocator);
    defer allocator.free(root);
    defer ws_io.deleteTree(root) catch {};
    const app_dir = try appDir(allocator, root);
    defer allocator.free(app_dir);

    // The app's on-disk package.json carries the workspace: range.
    const app_pkg = try std.fs.path.join(allocator, &[_][]const u8{ app_dir, "package.json" });
    defer allocator.free(app_pkg);
    const original =
        \\{
        \\  "name": "@ws/app",
        \\  "version": "1.0.0",
        \\  "dependencies": { "@ws/core": "workspace:*" }
        \\}
    ;
    try writeTestFile(app_pkg, original);

    // A staged copy elsewhere, like createTarball's staging directory.
    const staging = try makeTestDir(allocator, "pantry-wsproto-staging");
    defer allocator.free(staging);
    defer ws_io.deleteTree(staging) catch {};
    const staged_pkg = try std.fs.path.join(allocator, &[_][]const u8{ staging, "package.json" });
    defer allocator.free(staged_pkg);
    try writeTestFile(staged_pkg, original);

    try workspace_publish.rewriteStagedManifest(allocator, staged_pkg, app_dir);

    const staged_content = try ws_io.readFileAlloc(allocator, staged_pkg, 1024 * 1024);
    defer allocator.free(staged_content);
    try expectDepRange(allocator, staged_content, "dependencies", "@ws/core", "0.2.9");

    // The on-disk source manifest is byte-for-byte untouched.
    const source_content = try ws_io.readFileAlloc(allocator, app_pkg, 1024 * 1024);
    defer allocator.free(source_content);
    try testing.expectEqualStrings(original, source_content);
}
