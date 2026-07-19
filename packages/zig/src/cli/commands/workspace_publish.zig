//! Workspace protocol rewriting for published package manifests.
//!
//! A literal `workspace:` range must never reach a registry — npm and bun
//! cannot install it, so a package published with one is uninstallable.
//! `pantry publish` and `pantry publish:commit` rewrite those ranges in the
//! staged manifest that goes into the tarball, exactly like `bun publish`:
//!
//!   "workspace:*" / bare "workspace:" -> exact version   ("0.1.0")
//!   "workspace:^"                     -> caret range     ("^0.1.0")
//!   "workspace:~"                     -> tilde range     ("~0.1.0")
//!   "workspace:<range>"               -> range kept, prefix stripped
//!                                        ("workspace:^1.0.0" -> "^1.0.0")
//!
//! Ranges are rewritten across dependencies, devDependencies,
//! peerDependencies, and optionalDependencies (bun/npm keep devDependencies
//! in the published manifest, so workspace refs there must be rewritten
//! too). Versions resolve from the workspace's own packages, discovered by
//! expanding the `workspaces` globs of the nearest package.json that
//! declares them. An unresolvable reference fails loudly with
//! error.UnresolvableWorkspaceDependency and a message naming the
//! dependency.
//!
//! The repo's on-disk package.json is never mutated — only the staged copy
//! that goes into the tarball.

const std = @import("std");
const io_helper = @import("../../io_helper.zig");
const style = @import("../style.zig");
const advanced_glob = @import("../../packages/advanced_glob.zig");

/// Dependency sections that may carry workspace: ranges in a published manifest.
const dep_sections = [_][]const u8{ "dependencies", "devDependencies", "peerDependencies", "optionalDependencies" };

/// Cap on workspace-root search depth and member-package scan depth.
const max_search_depth = 12;

const WorkspaceRef = struct {
    name: []const u8,
    section: []const u8,
    range: []const u8,
};

/// Rewrite workspace: protocol ranges in the staged package.json at
/// `staged_manifest_path`, resolving versions from the workspace containing
/// `package_dir`. No-op when the manifest has no workspace: refs.
pub fn rewriteStagedManifest(
    allocator: std.mem.Allocator,
    staged_manifest_path: []const u8,
    package_dir: []const u8,
) !void {
    const content = io_helper.readFileAlloc(allocator, staged_manifest_path, 10 * 1024 * 1024) catch return;
    defer allocator.free(content);

    const rewritten = try rewriteManifestContent(allocator, content, package_dir);
    defer if (rewritten.ptr != content.ptr) allocator.free(rewritten);
    if (rewritten.ptr == content.ptr) return;

    const file = try io_helper.createFile(staged_manifest_path, .{ .truncate = true });
    defer file.close(io_helper.io);
    try io_helper.writeAllToFile(file, rewritten);
}

/// Rewrite workspace: protocol ranges in package.json `content`, resolving
/// versions from the workspace containing `package_dir`. Returns the
/// original slice when there is nothing to rewrite (callers compare
/// pointers), or an allocator-owned copy otherwise.
pub fn rewriteManifestContent(
    allocator: std.mem.Allocator,
    content: []const u8,
    package_dir: []const u8,
) ![]const u8 {
    // Cheap pre-check: no workspace refs anywhere → untouched.
    if (std.mem.indexOf(u8, content, "\"workspace:") == null) return content;

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, content, .{}) catch return content;
    defer parsed.deinit();
    if (parsed.value != .object) return content;

    if (firstWorkspaceRef(parsed.value) == null) return content;

    const root = findWorkspaceRoot(allocator, package_dir) orelse {
        const ref = firstWorkspaceRef(parsed.value).?;
        return failUnresolvable(ref, "no workspace root (a package.json with \"workspaces\") was found at or above the package directory");
    };
    defer allocator.free(root);

    var packages = try resolveWorkspacePackages(allocator, root);
    defer freeWorkspacePackages(allocator, &packages);

    // Allocated replacement ranges — freed after serialization.
    var replacements = std.ArrayList([]const u8).empty;
    defer {
        for (replacements.items) |s| allocator.free(s);
        replacements.deinit(allocator);
    }

    var changed = false;
    for (dep_sections) |section| {
        const deps_ptr = parsed.value.object.getPtr(section) orelse continue;
        if (deps_ptr.* != .object) continue;
        var iter = deps_ptr.object.iterator();
        while (iter.next()) |entry| {
            const range_val = entry.value_ptr;
            if (range_val.* != .string) continue;
            const range = range_val.string;
            if (!std.mem.startsWith(u8, range, "workspace:")) continue;
            const dep_name = entry.key_ptr.*;
            const spec = range["workspace:".len..];

            const version = packages.get(dep_name) orelse {
                return failUnresolvable(
                    .{ .name = dep_name, .section = section, .range = range },
                    "no workspace package with that name exists below the workspace root",
                );
            };
            if (version.len == 0) {
                return failUnresolvable(
                    .{ .name = dep_name, .section = section, .range = range },
                    "the workspace package has no \"version\" field",
                );
            }

            const resolved = try resolveSpec(allocator, spec, version);
            try replacements.append(allocator, resolved);
            // In-place value replacement keeps the map iterator valid.
            range_val.* = .{ .string = resolved };
            changed = true;

            style.print("  Resolved {s}: {s} → {s}\n", .{ dep_name, range, resolved });
        }
    }

    if (!changed) return content;

    const serialized = try std.json.Stringify.valueAlloc(allocator, parsed.value, .{ .whitespace = .indent_2 });
    defer allocator.free(serialized);
    return try std.fmt.allocPrint(allocator, "{s}\n", .{serialized});
}

/// Compute the published range for a workspace: spec given the resolved version.
fn resolveSpec(allocator: std.mem.Allocator, spec: []const u8, version: []const u8) ![]const u8 {
    // "workspace:*" and bare "workspace:" pin the exact current version.
    if (spec.len == 0 or std.mem.eql(u8, spec, "*")) return try allocator.dupe(u8, version);
    if (std.mem.eql(u8, spec, "^")) return try std.fmt.allocPrint(allocator, "^{s}", .{version});
    if (std.mem.eql(u8, spec, "~")) return try std.fmt.allocPrint(allocator, "~{s}", .{version});
    // "workspace:<range>" keeps the range verbatim, dropping the protocol prefix.
    return try allocator.dupe(u8, spec);
}

fn failUnresolvable(ref: WorkspaceRef, reason: []const u8) error{UnresolvableWorkspaceDependency} {
    style.printError(
        "Cannot publish: dependency \"{s}\" ({s}) uses \"{s}\" but {s}.\nRefusing to publish an unresolvable workspace: range — the published package would be uninstallable.\n",
        .{ ref.name, ref.section, ref.range, reason },
    );
    return error.UnresolvableWorkspaceDependency;
}

fn firstWorkspaceRef(root: std.json.Value) ?WorkspaceRef {
    if (root != .object) return null;
    for (dep_sections) |section| {
        const deps = root.object.get(section) orelse continue;
        if (deps != .object) continue;
        for (deps.object.keys(), deps.object.values()) |name, range_val| {
            if (range_val != .string) continue;
            if (std.mem.startsWith(u8, range_val.string, "workspace:")) {
                return .{ .name = name, .section = section, .range = range_val.string };
            }
        }
    }
    return null;
}

/// Extract the workspace glob array from a parsed root package.json —
/// array form (`"workspaces": [...]`) or the object form
/// (`"workspaces": { "packages": [...] }`).
fn workspaceGlobs(root: std.json.Value) ?std.json.Array {
    if (root != .object) return null;
    const ws = root.object.get("workspaces") orelse return null;
    return switch (ws) {
        .array => |a| a,
        .object => |o| blk: {
            const p = o.get("packages") orelse break :blk null;
            if (p == .array) break :blk p.array;
            break :blk null;
        },
        else => null,
    };
}

/// Locate the workspace root for `start_dir`: the nearest directory at or
/// above it whose package.json declares a non-empty `workspaces` field.
/// Returns an allocator-owned path, or null when no ancestor declares
/// workspaces.
pub fn findWorkspaceRoot(allocator: std.mem.Allocator, start_dir: []const u8) ?[]const u8 {
    var current: []const u8 = start_dir;
    var depth: usize = 0;
    while (depth < max_search_depth) : (depth += 1) {
        const pkg_path = std.fs.path.join(allocator, &[_][]const u8{ current, "package.json" }) catch return null;
        defer allocator.free(pkg_path);

        if (io_helper.readFileAlloc(allocator, pkg_path, 1024 * 1024) catch null) |content| {
            defer allocator.free(content);
            // Cheap text check first to avoid parsing every package.json on
            // the walk; only parse when the workspaces key appears at all.
            if (std.mem.indexOf(u8, content, "\"workspaces\"") != null) {
                if (std.json.parseFromSlice(std.json.Value, allocator, content, .{}) catch null) |parsed_value| {
                    var parsed = parsed_value;
                    defer parsed.deinit();
                    if (workspaceGlobs(parsed.value)) |globs| {
                        if (globs.items.len > 0) return allocator.dupe(u8, current) catch null;
                    }
                }
            }
        }

        const parent = std.fs.path.dirname(current) orelse return null;
        if (std.mem.eql(u8, parent, current)) return null;
        current = parent;
    }
    return null;
}

/// Discover the workspace's own packages by expanding the root package.json
/// `workspaces` globs. Maps package name → version (an empty version string
/// means the member manifest has no "version" field — rewriting fails
/// loudly if it is referenced). Keys and values are allocator-owned; free
/// with freeWorkspacePackages.
pub fn resolveWorkspacePackages(allocator: std.mem.Allocator, root_dir: []const u8) !std.StringHashMap([]const u8) {
    var packages = std.StringHashMap([]const u8).init(allocator);
    errdefer freeWorkspacePackages(allocator, &packages);

    const root = std.mem.trimEnd(u8, root_dir, "/");
    if (root.len == 0) return packages;

    const root_pkg_path = try std.fs.path.join(allocator, &[_][]const u8{ root, "package.json" });
    defer allocator.free(root_pkg_path);

    const content = io_helper.readFileAlloc(allocator, root_pkg_path, 10 * 1024 * 1024) catch return packages;
    defer allocator.free(content);

    const parsed = std.json.parseFromSlice(std.json.Value, allocator, content, .{}) catch return packages;
    defer parsed.deinit();

    const globs = workspaceGlobs(parsed.value) orelse return packages;

    for (globs.items) |glob_val| {
        if (glob_val != .string) continue;
        try collectGlobPackages(allocator, root, normalizeGlob(glob_val.string), &packages);
    }

    return packages;
}

/// Free every key/value plus the map itself.
pub fn freeWorkspacePackages(allocator: std.mem.Allocator, packages: *std.StringHashMap([]const u8)) void {
    var it = packages.iterator();
    while (it.next()) |entry| {
        allocator.free(entry.key_ptr.*);
        allocator.free(entry.value_ptr.*);
    }
    packages.deinit();
}

fn normalizeGlob(pattern: []const u8) []const u8 {
    var p = pattern;
    if (std.mem.startsWith(u8, p, "./")) p = p[2..];
    while (p.len > 1 and p[p.len - 1] == '/') p = p[0 .. p.len - 1];
    return p;
}

/// The glob-free leading path of a workspace pattern — traversal only needs
/// to descend below this prefix. "" means the pattern is globby from the
/// workspace root itself.
fn staticPrefix(pattern: []const u8) []const u8 {
    const first_meta = std.mem.indexOfAny(u8, pattern, "*?{") orelse return pattern;
    const slash = std.mem.lastIndexOfScalar(u8, pattern[0..first_meta], '/') orelse return "";
    return pattern[0..slash];
}

fn collectGlobPackages(
    allocator: std.mem.Allocator,
    root: []const u8,
    pattern: []const u8,
    packages: *std.StringHashMap([]const u8),
) !void {
    // Exact (non-glob) pattern: check the directory directly.
    if (std.mem.indexOfAny(u8, pattern, "*?{") == null) {
        try tryAddPackageDir(allocator, root, pattern, packages);
        return;
    }

    const prefix = staticPrefix(pattern);
    const base = if (prefix.len == 0)
        try allocator.dupe(u8, root)
    else
        try std.fs.path.join(allocator, &[_][]const u8{ root, prefix });
    defer allocator.free(base);

    try walkForGlob(allocator, root, base, pattern, packages, 0);
}

fn walkForGlob(
    allocator: std.mem.Allocator,
    root: []const u8,
    dir: []const u8,
    pattern: []const u8,
    packages: *std.StringHashMap([]const u8),
    depth: usize,
) !void {
    if (depth > max_search_depth) return;

    var d = io_helper.openDirForIteration(dir) catch return;
    defer d.close();

    var iter = d.iterate();
    while (iter.next() catch null) |entry| {
        if (entry.kind != .directory) continue;
        if (std.mem.startsWith(u8, entry.name, ".")) continue;
        if (std.mem.eql(u8, entry.name, "node_modules")) continue;

        const sub = try std.fs.path.join(allocator, &[_][]const u8{ dir, entry.name });
        defer allocator.free(sub);

        // `sub` always descends from `root`, so the workspace-relative path
        // is a simple slice.
        const rel = sub[root.len + 1 ..];

        if (advanced_glob.matchGlob(pattern, rel)) {
            try tryAddPackageDir(allocator, root, rel, packages);
        }
        try walkForGlob(allocator, root, sub, pattern, packages, depth + 1);
    }
}

fn tryAddPackageDir(
    allocator: std.mem.Allocator,
    root: []const u8,
    rel: []const u8,
    packages: *std.StringHashMap([]const u8),
) !void {
    const pkg_json_path = try std.fs.path.join(allocator, &[_][]const u8{ root, rel, "package.json" });
    defer allocator.free(pkg_json_path);

    const content = io_helper.readFileAlloc(allocator, pkg_json_path, 1024 * 1024) catch return;
    defer allocator.free(content);

    const parsed = std.json.parseFromSlice(std.json.Value, allocator, content, .{}) catch return;
    defer parsed.deinit();
    if (parsed.value != .object) return;

    const name_val = parsed.value.object.get("name") orelse return;
    if (name_val != .string or name_val.string.len == 0) return;
    // First match wins — a name shadowed by an earlier glob stays stable.
    if (packages.contains(name_val.string)) return;

    const version: []const u8 = if (parsed.value.object.get("version")) |v|
        if (v == .string) v.string else ""
    else
        "";

    try packages.put(try allocator.dupe(u8, name_val.string), try allocator.dupe(u8, version));
}
