const std = @import("std");
const io_helper = @import("../io_helper.zig");
const style = @import("../cli/style.zig");

pub const DepsFile = struct {
    path: []const u8,
    format: FileFormat,

    pub const FileFormat = enum {
        pantry_json, // pantry.json (highest priority)
        pantry_jsonc, // pantry.jsonc
        pantry_yaml, // pantry.yaml
        pantry_yml, // pantry.yml
        deps_yaml, // deps.yaml (before TS configs - no runtime needed)
        deps_yml,
        dependencies_yaml,
        pkgx_yaml,
        config_deps_ts, // config/deps.ts (typed TS config - needs runtime)
        dotconfig_deps_ts, // .config/deps.ts
        pantry_config_ts, // pantry.config.ts (needs runtime)
        dotconfig_pantry_ts, // .config/pantry.ts
        package_json, // package.json (npm/bun/yarn compatible)
        package_jsonc, // Zig package.jsonc
        zig_json, // zig.json
        cargo_toml,
        pyproject_toml,
        requirements_txt,
        gemfile,
        go_mod,
        composer_json,
    };
};

/// Workspace file detection result
pub const WorkspaceFile = struct {
    path: []const u8,
    root_dir: []const u8,

    pub fn deinit(self: *WorkspaceFile, allocator: std.mem.Allocator) void {
        allocator.free(self.path);
        allocator.free(self.root_dir);
    }
};

const DepsFileInfo = struct { name: []const u8, format: DepsFile.FileFormat };

/// Paired list of dependency file names and their formats.
/// Order defines priority (highest first).
const deps_files_table = [_]DepsFileInfo{
    .{ .name = "pantry.json", .format = .pantry_json },
    .{ .name = "pantry.jsonc", .format = .pantry_jsonc },
    .{ .name = "pantry.yaml", .format = .pantry_yaml },
    .{ .name = "pantry.yml", .format = .pantry_yml },
    .{ .name = "deps.yaml", .format = .deps_yaml },
    .{ .name = "deps.yml", .format = .deps_yml },
    .{ .name = "dependencies.yaml", .format = .dependencies_yaml },
    .{ .name = "pkgx.yaml", .format = .pkgx_yaml },
    .{ .name = "config/deps.ts", .format = .config_deps_ts },
    .{ .name = ".config/deps.ts", .format = .dotconfig_deps_ts },
    .{ .name = "pantry.config.ts", .format = .pantry_config_ts },
    .{ .name = ".config/pantry.ts", .format = .dotconfig_pantry_ts },
    .{ .name = "package.json", .format = .package_json },
    .{ .name = "package.jsonc", .format = .package_jsonc },
    .{ .name = "zig.json", .format = .zig_json },
    .{ .name = "Cargo.toml", .format = .cargo_toml },
    .{ .name = "pyproject.toml", .format = .pyproject_toml },
    .{ .name = "requirements.txt", .format = .requirements_txt },
    .{ .name = "Gemfile", .format = .gemfile },
    .{ .name = "go.mod", .format = .go_mod },
    .{ .name = "composer.json", .format = .composer_json },
};

/// Find a dependency file owned by this directory, without walking to a parent.
pub fn findDepsFileInDirectory(allocator: std.mem.Allocator, directory: []const u8) !?DepsFile {
    for (deps_files_table) |entry| {
        const path = try std.fs.path.join(allocator, &.{ directory, entry.name });
        errdefer allocator.free(path);
        io_helper.accessAbsolute(path, .{}) catch {
            allocator.free(path);
            continue;
        };
        return .{ .path = path, .format = entry.format };
    }
    return null;
}

/// Find dependency file in directory or parent directories
pub fn findDepsFile(allocator: std.mem.Allocator, start_dir: []const u8) !?DepsFile {
    var current_dir_buf: [std.fs.max_path_bytes]u8 = undefined;
    const current_dir = try io_helper.realpath(start_dir, &current_dir_buf);

    var dir_path = try allocator.dupe(u8, current_dir);
    defer allocator.free(dir_path);

    // Walk up the directory tree
    while (true) {
        // Perf: Use stack buffer for path construction (avoids allocator per candidate)
        var path_buf: [std.fs.max_path_bytes]u8 = undefined;

        // Try each dependency file name
        for (deps_files_table) |entry| {
            const full_path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ dir_path, entry.name }) catch continue;

            // Check if file exists
            io_helper.accessAbsolute(full_path, .{}) catch {
                continue;
            };

            // Found a dependency file!
            return DepsFile{
                .path = try allocator.dupe(u8, full_path),
                .format = entry.format,
            };
        }

        // Move to parent directory
        const parent = std.fs.path.dirname(dir_path) orelse break;
        if (std.mem.eql(u8, parent, dir_path)) break; // Reached root

        const new_dir = try allocator.dupe(u8, parent);
        allocator.free(dir_path);
        dir_path = new_dir;
    }

    return null;
}

/// Check if a filename is a recognized deps file
pub fn isDepsFile(filename: []const u8) bool {
    const deps_files = [_][]const u8{
        "deps.ts",
        "deps.yaml",
        "deps.yml",
        "dependencies.yaml",
        "dependencies.yml",
        "pkgx.yaml",
        "pkgx.yml",
        "pantry.yaml",
        "pantry.yml",
        "pantry.config.ts",
        "pantry.config.js",
    };

    for (deps_files) |deps_file| {
        if (std.mem.eql(u8, filename, deps_file)) return true;
    }

    // Also check for config/deps.ts and .config/ patterns
    if (std.mem.endsWith(u8, filename, "config/deps.ts")) return true;
    if (std.mem.endsWith(u8, filename, ".config/deps.ts")) return true;
    if (std.mem.endsWith(u8, filename, ".config/pantry.ts")) return true;

    return false;
}

/// Infer format from filename
pub fn inferFormat(filename: []const u8) ?DepsFile.FileFormat {
    // Pantry formats first (highest priority)
    if (std.mem.eql(u8, filename, "pantry.json")) return .pantry_json;
    if (std.mem.eql(u8, filename, "pantry.jsonc")) return .pantry_jsonc;
    if (std.mem.eql(u8, filename, "pantry.yaml")) return .pantry_yaml;
    if (std.mem.eql(u8, filename, "pantry.yml")) return .pantry_yml;
    if (std.mem.endsWith(u8, filename, ".config/deps.ts")) return .dotconfig_deps_ts;
    if (std.mem.endsWith(u8, filename, "config/deps.ts")) return .config_deps_ts;
    if (std.mem.eql(u8, filename, "pantry.config.ts")) return .pantry_config_ts;
    if (std.mem.endsWith(u8, filename, ".config/pantry.ts")) return .dotconfig_pantry_ts;
    if (std.mem.eql(u8, filename, "deps.yaml")) return .deps_yaml;
    if (std.mem.eql(u8, filename, "deps.yml")) return .deps_yml;
    if (std.mem.eql(u8, filename, "dependencies.yaml")) return .dependencies_yaml;
    if (std.mem.eql(u8, filename, "pkgx.yaml")) return .pkgx_yaml;
    // Other package managers (fallback)
    if (std.mem.eql(u8, filename, "package.json")) return .package_json;
    if (std.mem.eql(u8, filename, "package.jsonc")) return .package_jsonc;
    if (std.mem.eql(u8, filename, "zig.json")) return .zig_json;
    if (std.mem.eql(u8, filename, "Cargo.toml")) return .cargo_toml;
    if (std.mem.eql(u8, filename, "pyproject.toml")) return .pyproject_toml;
    if (std.mem.eql(u8, filename, "requirements.txt")) return .requirements_txt;
    if (std.mem.eql(u8, filename, "Gemfile")) return .gemfile;
    if (std.mem.eql(u8, filename, "go.mod")) return .go_mod;
    if (std.mem.eql(u8, filename, "composer.json")) return .composer_json;
    return null;
}

/// Find workspace configuration file in directory or parent directories
/// Uses the same project membership rules as combined dependency discovery.
pub fn findWorkspaceFile(allocator: std.mem.Allocator, start_dir: []const u8) !?WorkspaceFile {
    const files = try findDepsAndWorkspaceFile(allocator, start_dir);
    if (files.deps_file) |file| allocator.free(file.path);
    return files.workspace_file;
}

/// Match the nearest manifest's directory, not every descendant of a member.
/// A standalone example inside packages/member is not itself packages/member.
fn workspaceContainsProject(allocator: std.mem.Allocator, contents: []const u8, file_name: []const u8, root: []const u8, project: []const u8) !?bool {
    const jsonc = @import("../utils/jsonc.zig");
    const uncommented = if (std.mem.endsWith(u8, file_name, ".jsonc")) try jsonc.stripComments(allocator, contents) else contents;
    defer if (uncommented.ptr != contents.ptr) allocator.free(uncommented);
    const normalized = try jsonc.stripTrailingCommas(allocator, uncommented);
    defer allocator.free(normalized);
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, normalized, .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;
    const declaration = parsed.value.object.get("workspaces") orelse return null;
    // Preserve root validation in the owning workspace configuration loader.
    if (std.mem.eql(u8, root, project)) return true;
    const patterns = if (declaration == .object) declaration.object.get("packages") orelse return false else declaration;
    const relative = try std.fs.path.relative(allocator, root, null, root, project);
    defer allocator.free(relative);
    if (@import("builtin").os.tag == .windows) std.mem.replaceScalar(u8, relative, '\\', '/');
    const glob = @import("../packages/advanced_glob.zig");
    var included = false;
    switch (patterns) {
        .string => |pattern| return glob.matchGlob(workspacePattern(pattern), relative),
        .array => |items| for (items.items) |item| {
            if (item != .string) continue;
            const excluded = std.mem.startsWith(u8, item.string, "!");
            const pattern = if (excluded) item.string[1..] else item.string;
            if (glob.matchGlob(workspacePattern(pattern), relative)) {
                if (excluded) return false;
                included = true;
            }
        },
        else => return false,
    }
    return included;
}

fn workspacePattern(pattern: []const u8) []const u8 {
    var result = pattern;
    while (std.mem.startsWith(u8, result, "./")) result = result[2..];
    return std.mem.trimEnd(u8, result, "/");
}

/// Combined result from findDepsAndWorkspaceFile
pub const DepsAndWorkspaceResult = struct {
    deps_file: ?DepsFile = null,
    workspace_file: ?WorkspaceFile = null,
};

/// Find both dependency file and workspace file in a single directory walk.
/// This avoids the overhead of two separate realpath + directory traversals.
pub fn findDepsAndWorkspaceFile(allocator: std.mem.Allocator, start_dir: []const u8) !DepsAndWorkspaceResult {
    const dep_file_names = [_][]const u8{
        "pantry.json",    "pantry.jsonc",     "pantry.yaml",       "pantry.yml",
        "deps.yaml",      "deps.yml",         "dependencies.yaml", "pkgx.yaml",
        "config/deps.ts", ".config/deps.ts",  "pantry.config.ts",  ".config/pantry.ts",
        "package.json",   "package.jsonc",    "zig.json",          "Cargo.toml",
        "pyproject.toml", "requirements.txt", "Gemfile",           "go.mod",
        "composer.json",
    };
    const workspace_file_names = [_][]const u8{ "pantry.json", "pantry.jsonc", "package.json" };

    var current_dir_buf: [std.fs.max_path_bytes]u8 = undefined;
    const current_dir = try io_helper.realpath(start_dir, &current_dir_buf);

    var dir_path = try allocator.dupe(u8, current_dir);
    defer allocator.free(dir_path);

    var result: DepsAndWorkspaceResult = .{};
    var project_dir: ?[]const u8 = null;
    defer if (project_dir) |project| allocator.free(project);
    errdefer {
        if (result.deps_file) |file| allocator.free(file.path);
        if (result.workspace_file) |file| {
            allocator.free(file.path);
            allocator.free(file.root_dir);
        }
    }

    while (true) {
        // Check for deps file (if not already found)
        if (result.deps_file == null) {
            for (dep_file_names, 0..) |file_name, i| {
                const full_path = try std.fs.path.join(allocator, &[_][]const u8{ dir_path, file_name });
                defer allocator.free(full_path);
                io_helper.accessAbsolute(full_path, .{}) catch continue;
                const format: DepsFile.FileFormat = @fromBackingInt(@intCast(i));
                result.deps_file = DepsFile{
                    .path = try allocator.dupe(u8, full_path),
                    .format = format,
                };
                project_dir = try allocator.dupe(u8, dir_path);
                break;
            }
        }

        // Check for workspace file (if not already found)
        if (result.workspace_file == null) {
            for (workspace_file_names) |file_name| {
                const full_path = try std.fs.path.join(allocator, &[_][]const u8{ dir_path, file_name });
                defer allocator.free(full_path);
                io_helper.accessAbsolute(full_path, .{}) catch continue;

                const contents = io_helper.readFileAlloc(allocator, full_path, 10 * 1024 * 1024) catch continue;
                defer allocator.free(contents);

                if (try workspaceContainsProject(allocator, contents, file_name, dir_path, project_dir orelse dir_path)) |owns_project| {
                    if (owns_project) {
                        result.workspace_file = WorkspaceFile{
                            .path = try allocator.dupe(u8, full_path),
                            .root_dir = try allocator.dupe(u8, dir_path),
                        };
                    }
                    // A lower-priority manifest cannot widen this declaration.
                    break;
                }
            }
        }

        // If we found both, we're done
        if (result.deps_file != null and result.workspace_file != null) break;

        // Move to parent directory
        const parent = std.fs.path.dirname(dir_path) orelse break;
        if (std.mem.eql(u8, parent, dir_path)) break;

        const new_dir = try allocator.dupe(u8, parent);
        allocator.free(dir_path);
        dir_path = new_dir;
    }

    return result;
}

/// Resolve the effective project root for a given directory.
/// In a workspace, returns the workspace root (packages are hoisted there, like Bun).
/// Otherwise, returns a dupe of `cwd`. Caller must free the result.
pub fn resolveProjectRoot(allocator: std.mem.Allocator, cwd: []const u8) ![]const u8 {
    const ws_file = findWorkspaceFile(allocator, cwd) catch null;
    if (ws_file) |ws| {
        defer allocator.free(ws.path);
        return ws.root_dir; // Already allocated
    }
    return try allocator.dupe(u8, cwd);
}

test "findDepsFile" {
    const allocator = std.testing.allocator;

    // Test with current directory
    const result = try findDepsFile(allocator, ".");
    if (result) |deps_file| {
        defer allocator.free(deps_file.path);
        style.print("Found: {s}\n", .{deps_file.path});
    }
}

test "workspace discovery: a nested standalone manifest does not select an unrelated parent workspace" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_helper.io, "artifacts/project with spaces/src");
    try tmp.dir.createDirPath(io_helper.io, "packages/member/src");
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data = "{\"workspaces\":[\"packages/*\"]}" });
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "artifacts/project with spaces/deps.yaml", .data = "dependencies:\n  swig.org: 4.5.1\n" });
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "packages/member/package.json", .data = "{\"name\":\"member\"}" });
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const length = try tmp.dir.realPathFile(io_helper.io, ".", &buffer);
    const root = buffer[0..length];
    const standalone = try std.fs.path.join(allocator, &.{ root, "artifacts/project with spaces" });
    const nested = try std.fs.path.join(allocator, &.{ standalone, "src" });
    for ([_][]const u8{ standalone, nested }) |start| {
        try std.testing.expect(try findWorkspaceFile(allocator, start) == null);
        const files = try findDepsAndWorkspaceFile(allocator, start);
        try std.testing.expect(files.workspace_file == null);
        try std.testing.expectEqualStrings(try std.fs.path.join(allocator, &.{ standalone, "deps.yaml" }), files.deps_file.?.path);
    }
    try std.testing.expectEqualStrings(standalone, try resolveProjectRoot(allocator, standalone));
    const member = try std.fs.path.join(allocator, &.{ root, "packages/member/src" });
    try std.testing.expectEqualStrings(root, (try findWorkspaceFile(allocator, member)).?.root_dir);
    try std.testing.expectEqualStrings(root, (try findDepsAndWorkspaceFile(allocator, member)).workspace_file.?.root_dir);
    try std.testing.expectEqualStrings(root, try resolveProjectRoot(allocator, member));
    try std.testing.expectEqualStrings(root, (try findWorkspaceFile(allocator, root)).?.root_dir);
}

test "workspace discovery: nested projects inside members retain their own boundary" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_helper.io, "packages/member/examples/standalone");
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.jsonc", .data = "{\n// workspace declaration\n\"workspaces\": {\"packages\": [\"./packages/*\",],},\n}" });
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "packages/member/deps.yaml", .data = "dependencies: {}\n" });
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "packages/member/examples/standalone/pantry.json", .data = "{\"dependencies\":{}}" });
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const length = try tmp.dir.realPathFile(io_helper.io, ".", &buffer);
    const root = buffer[0..length];
    const standalone = try std.fs.path.join(allocator, &.{ root, "packages/member/examples/standalone" });
    try std.testing.expect(try findWorkspaceFile(allocator, standalone) == null);
    try std.testing.expect((try findDepsAndWorkspaceFile(allocator, standalone)).workspace_file == null);
    const member = try std.fs.path.join(allocator, &.{ root, "packages/member" });
    try std.testing.expectEqualStrings(root, (try findWorkspaceFile(allocator, member)).?.root_dir);
}

test "workspace discovery: declarations own recursive members but metadata strings do not declare workspaces" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_helper.io, "projects/group/member/config");
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data = "{\"description\":\"workspaces\"}" });
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "projects/group/member/config/deps.ts", .data = "export default {}" });
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const length = try tmp.dir.realPathFile(io_helper.io, ".", &buffer);
    const root = buffer[0..length];
    const member = try std.fs.path.join(allocator, &.{ root, "projects/group/member" });
    try std.testing.expect(try findWorkspaceFile(allocator, member) == null);
    try std.testing.expect((try findDepsAndWorkspaceFile(allocator, member)).workspace_file == null);
    for ([_][]const u8{
        "{\"workspaces\":\"projects/**\"}",
        "{\"workspaces\":[\"projects/**\"]}",
        "{\"workspaces\":{\"packages\":[\"projects/**\"]}}",
    }) |manifest| {
        try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data = manifest });
        try std.testing.expectEqualStrings(root, (try findWorkspaceFile(allocator, member)).?.root_dir);
        try std.testing.expectEqualStrings(root, (try findDepsAndWorkspaceFile(allocator, member)).workspace_file.?.root_dir);
    }
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data = "{\"workspaces\":[\"projects/**\",\"!projects/group/**\"]}" });
    try std.testing.expect(try findWorkspaceFile(allocator, member) == null);
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "projects/group/member/package.json", .data = "{\"workspaces\":[\"children/*\"]}" });
    try std.testing.expectEqualStrings(member, (try findWorkspaceFile(allocator, member)).?.root_dir);
}

test "workspace discovery: lower-priority manifests cannot widen the selected workspace" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_helper.io, "projects/standalone");
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.json", .data = "{\"workspaces\":[\"other/*\"]}" });
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "package.json", .data = "{\"workspaces\":[\"projects/*\"]}" });
    try tmp.dir.writeFile(io_helper.io, .{ .sub_path = "projects/standalone/deps.yaml", .data = "dependencies: {}\n" });
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const length = try tmp.dir.realPathFile(io_helper.io, ".", &buffer);
    const root = buffer[0..length];
    const standalone = try std.fs.path.join(allocator, &.{ root, "projects/standalone" });
    try std.testing.expect(try findWorkspaceFile(allocator, standalone) == null);
    try std.testing.expect((try findDepsAndWorkspaceFile(allocator, standalone)).workspace_file == null);
    try std.testing.expectEqualStrings(root, (try findWorkspaceFile(allocator, root)).?.root_dir);
}
