const std = @import("std");
const detector = @import("detector.zig");
const parser = @import("parser.zig");
const lib = @import("../lib.zig");
const io_helper = lib.io_helper;

/// Scan common locations for dependency files with global packages
pub fn scanForGlobalDeps(allocator: std.mem.Allocator) ![]parser.PackageDependency {
    // Allow disabling global dep scanning via env var (useful in CI/containers)
    if (io_helper.getEnvVarOwned(allocator, "PANTRY_NO_GLOBAL_SCAN")) |val| {
        defer allocator.free(val);
        if (std.mem.eql(u8, val, "1") or std.mem.eql(u8, val, "true")) {
            return &[_]parser.PackageDependency{};
        }
    } else |_| {}

    const home = io_helper.getEnvVarOwned(allocator, "HOME") catch |err| {
        if (err == error.EnvironmentVariableNotFound) {
            // Try USERPROFILE on Windows
            const userprofile = io_helper.getEnvVarOwned(allocator, "USERPROFILE") catch return &[_]parser.PackageDependency{};
            defer allocator.free(userprofile);
            return scanLocations(allocator, userprofile);
        }
        return &[_]parser.PackageDependency{};
    };
    defer allocator.free(home);

    return scanLocations(allocator, home);
}

fn scanLocations(allocator: std.mem.Allocator, home: []const u8) ![]parser.PackageDependency {

    // Common locations to search
    const search_locations = [_][]const u8{
        "", // Home directory root
        ".dotfiles",
        ".config",
        "Code",
        "Projects",
        "Development",
        "dev",
    };

    var all_global_deps = try std.ArrayList(parser.PackageDependency).initCapacity(allocator, 16);
    errdefer {
        for (all_global_deps.items) |*dep| dep.deinit(allocator);
        all_global_deps.deinit(allocator);
    }

    // Search each location
    for (search_locations) |location| {
        const search_path = if (location.len == 0)
            try allocator.dupe(u8, home)
        else
            try std.fmt.allocPrint(allocator, "{s}/{s}", .{ home, location });
        defer allocator.free(search_path);

        // Check if path exists
        io_helper.accessAbsolute(search_path, .{}) catch continue;

        // Look for deps files in this location (non-recursive for home dir, recursive for others)
        const is_home_root = location.len == 0;
        if (is_home_root) {
            // Only check root level for home directory
            try scanDirectoryForGlobalDeps(allocator, search_path, &all_global_deps, 0, 0);
        } else {
            // Search up to 3 levels deep for other directories
            try scanDirectoryForGlobalDeps(allocator, search_path, &all_global_deps, 3, 0);
        }
    }

    return all_global_deps.toOwnedSlice(allocator);
}

/// Scan the same well-known locations as `scanForGlobalDeps`, but return the
/// PATHS of deps files that declare at least one `global: true` package. The
/// global-install command uses these to install GUI apps/fonts (declared inline
/// or in sibling apps.yaml/fonts.yaml) the same way a project-local install does.
/// Caller owns the returned slice and each path.
pub fn scanForGlobalDepsFiles(allocator: std.mem.Allocator) ![][]const u8 {
    const home = io_helper.getEnvVarOwned(allocator, "HOME") catch return &[_][]const u8{};
    defer allocator.free(home);

    const search_locations = [_][]const u8{
        "", ".dotfiles", ".config", "Code", "Projects", "Development", "dev",
    };

    var paths = try std.ArrayList([]const u8).initCapacity(allocator, 8);
    errdefer {
        for (paths.items) |p| allocator.free(p);
        paths.deinit(allocator);
    }

    for (search_locations) |location| {
        const search_path = if (location.len == 0)
            try allocator.dupe(u8, home)
        else
            try std.fmt.allocPrint(allocator, "{s}/{s}", .{ home, location });
        defer allocator.free(search_path);

        io_helper.accessAbsolute(search_path, .{}) catch continue;
        const depth: usize = if (location.len == 0) 0 else 3;
        collectGlobalDepsFilePaths(allocator, search_path, &paths, depth, 0) catch {};
    }

    return paths.toOwnedSlice(allocator);
}

/// Recursively collect deps-file paths that contain a `global: true` dependency.
fn collectGlobalDepsFilePaths(
    allocator: std.mem.Allocator,
    dir_path: []const u8,
    paths: *std.ArrayList([]const u8),
    max_depth: usize,
    current_depth: usize,
) !void {
    if (current_depth > max_depth) return;

    var dir = io_helper.openDirAbsoluteForIteration(dir_path) catch return;
    defer dir.close();
    var iterator = dir.iterate();

    while (iterator.next() catch null) |entry| {
        if (entry.name[0] == '.' and current_depth > 0) continue;
        if (shouldSkipDirectory(entry.name)) continue;

        const entry_path = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ dir_path, entry.name });
        defer allocator.free(entry_path);

        switch (entry.kind) {
            .file => {
                if (!detector.isDepsFile(entry.name)) continue;
                const deps_file = detector.DepsFile{
                    .path = entry_path,
                    .format = detector.inferFormat(entry.name) orelse continue,
                };
                const deps = parser.inferDependencies(allocator, deps_file) catch continue;
                defer {
                    for (deps) |*dep| {
                        var d = dep.*;
                        d.deinit(allocator);
                    }
                    allocator.free(deps);
                }
                var has_global = false;
                for (deps) |dep| {
                    if (dep.global) {
                        has_global = true;
                        break;
                    }
                }
                if (!has_global) continue;
                // Dedup before keeping the path.
                var dup = false;
                for (paths.items) |p| {
                    if (std.mem.eql(u8, p, entry_path)) {
                        dup = true;
                        break;
                    }
                }
                if (!dup) try paths.append(allocator, try allocator.dupe(u8, entry_path));
            },
            .directory => try collectGlobalDepsFilePaths(allocator, entry_path, paths, max_depth, current_depth + 1),
            else => {},
        }
    }
}

/// Recursively scan a directory for deps files with global packages
fn scanDirectoryForGlobalDeps(
    allocator: std.mem.Allocator,
    dir_path: []const u8,
    global_deps: *std.ArrayList(parser.PackageDependency),
    max_depth: usize,
    current_depth: usize,
) !void {
    if (current_depth > max_depth) return;

    // Use std.fs.Dir for iteration (Io.Dir doesn't have iterate() in Zig 0.16)
    var dir = io_helper.openDirAbsoluteForIteration(dir_path) catch return;
    defer dir.close();

    var iterator = dir.iterate();

    while (iterator.next() catch null) |entry| {
        // Skip hidden files/directories (except .dotfiles and .config at root)
        if (entry.name[0] == '.' and current_depth > 0) continue;

        // Skip common directories that shouldn't be searched
        if (shouldSkipDirectory(entry.name)) continue;

        const entry_path = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ dir_path, entry.name });
        defer allocator.free(entry_path);

        switch (entry.kind) {
            .file => {
                // Check if this is a deps file
                if (detector.isDepsFile(entry.name)) {
                    // Try to parse it and extract global packages
                    const deps_file = detector.DepsFile{
                        .path = entry_path,
                        .format = detector.inferFormat(entry.name) orelse continue,
                    };

                    const deps = parser.inferDependencies(allocator, deps_file) catch continue;
                    defer {
                        for (deps) |*dep| {
                            var d = dep.*;
                            d.deinit(allocator);
                        }
                        allocator.free(deps);
                    }

                    // Filter for global packages only
                    for (deps) |dep| {
                        if (dep.global) {
                            try global_deps.append(allocator, .{
                                .name = try allocator.dupe(u8, dep.name),
                                .version = try allocator.dupe(u8, dep.version),
                                .global = true,
                            });
                        }
                    }
                }
            },
            .directory => {
                // Recurse into subdirectories
                try scanDirectoryForGlobalDeps(allocator, entry_path, global_deps, max_depth, current_depth + 1);
            },
            else => {},
        }
    }
}

/// Check if a directory should be skipped during scanning
fn shouldSkipDirectory(name: []const u8) bool {
    const skip_dirs = [_][]const u8{
        "node_modules",
        "vendor",
        ".git",
        ".svn",
        ".hg",
        "dist",
        "build",
        "target",
        "out",
        "tmp",
        "temp",
        ".cache",
        "cache",
        "__pycache__",
        ".venv",
        "venv",
        ".tox",
        "coverage",
    };

    for (skip_dirs) |skip_dir| {
        if (std.mem.eql(u8, name, skip_dir)) return true;
    }

    return false;
}
