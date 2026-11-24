//! `pantry install`'s side of install/artifact_refresh.zig: the registry
//! lookup and reinstall it is given, the project and global trees it runs
//! over, and what it prints.

const std = @import("std");
const io_helper = @import("../../../io_helper.zig");
const lib = @import("../../../lib.zig");
const types = @import("types.zig");
const style = @import("../../style.zig");
const offline = @import("../../../install/offline.zig");
const platform = @import("../../../core/platform.zig");
const artifact_refresh = @import("../../../install/artifact_refresh.zig");

const install = lib.install;

const Hooks = struct {
    installer: *install.Installer,
    /// null for a global tree.
    project_root: ?[]const u8,
    verbose: bool,
    /// Where a replacement also writes: download staging and the download
    /// cache (they may be on other filesystems than the tree).
    staging_dir: ?[]const u8 = null,
    cache_dir: ?[]const u8 = null,

    fn init(installer: *install.Installer, project_root: ?[]const u8, verbose: bool) Hooks {
        const allocator = installer.allocator;
        const home = lib.Paths.home(allocator) catch null;
        defer if (home) |h| allocator.free(h);
        return .{
            .installer = installer,
            .project_root = project_root,
            .verbose = verbose,
            // As installer.zig stages every native download.
            .staging_dir = if (home) |h| std.fmt.allocPrint(allocator, "{s}/.pantry/.tmp", .{h}) catch null else null,
            .cache_dir = lib.Paths.cache(allocator) catch null,
        };
    }

    fn deinit(self: *Hooks) void {
        if (self.staging_dir) |d| self.installer.allocator.free(d);
        if (self.cache_dir) |d| self.installer.allocator.free(d);
    }

    fn registryArtifact(context: *anyopaque, domain: []const u8, version: []const u8) anyerror!?artifact_refresh.RegistryArtifact {
        const self: *Hooks = @ptrCast(@alignCast(context));
        const allocator = self.installer.allocator;
        const found = (try install.downloader.lookupS3Registry(allocator, domain, version)) orelse return null;
        defer allocator.free(found.tarball_url);
        defer allocator.free(found.version);
        // Only that exact version's artifact says anything about this copy.
        if (!std.mem.eql(u8, found.version, version)) return null;
        const identity = found.archive_identity orelse return null;
        return .{ .sha256 = identity.sha256, .size = identity.size, .uploaded_at_ms = found.uploaded_at_ms };
    }

    /// The least free space among the tree, download staging and the
    /// download cache: the check asks every filesystem for the whole
    /// requirement, which only errs towards leaving a copy as it is.
    fn freeSpace(context: *anyopaque, dir: []const u8) ?u64 {
        const self: *Hooks = @ptrCast(@alignCast(context));
        var least: ?u64 = artifact_refresh.freeBytesNear(dir);
        for ([_]?[]const u8{ self.staging_dir, self.cache_dir }) |maybe| {
            const path = maybe orelse continue;
            const free = artifact_refresh.freeBytesNear(path) orelse continue;
            least = if (least) |l| @min(l, free) else free;
        }
        return least;
    }

    fn reinstall(context: *anyopaque, domain: []const u8, version: []const u8, digest: artifact_refresh.Digest) anyerror!void {
        const self: *Hooks = @ptrCast(@alignCast(context));
        var result = try self.installer.install(.{ .name = domain, .version = version }, .{
            .project_root = self.project_root,
            .replace_artifact = true,
            .quiet = true,
            .verbose = self.verbose,
        });
        defer result.deinit(self.installer.allocator);
        // The installer records the archive only after verifying the bytes
        // against the registry's identity. Anything else did not replace it.
        const recorded = artifact_refresh.readMarker(result.install_path) orelse return error.ArtifactNotRecorded;
        if (!std.mem.eql(u8, &recorded, &digest)) return error.ArtifactChangedDuringInstall;
    }

    fn hooks(self: *Hooks) artifact_refresh.Hooks {
        return .{ .context = self, .registryArtifact = registryArtifact, .reinstall = reinstall, .freeSpace = freeSpace };
    }
};

fn printReport(report: artifact_refresh.Report, verbose: bool) void {
    for (report.changes) |change| {
        if (change.from != null) {
            style.print("  {s}~{s} {s} {s} {s}rebuilt artifact{s}\n", .{ style.dim, style.reset, change.domain, change.version, style.dim, style.reset });
        } else {
            style.print("  {s}~{s} {s} {s} {s}re-fetched artifact (no recorded hash){s}\n", .{ style.dim, style.reset, change.domain, change.version, style.dim, style.reset });
        }
    }
    for (report.skipped) |skip| {
        var need_buf: [32]u8 = undefined;
        var have_buf: [32]u8 = undefined;
        style.printWarn("{s} {s}: not enough free space to replace (need {s}, have {s}); left as is\n", .{
            skip.domain,
            skip.version,
            artifact_refresh.formatBytes(&need_buf, skip.need),
            artifact_refresh.formatBytes(&have_buf, skip.have),
        });
    }
    for (report.failures) |failure| {
        style.printWarn("{s} {s}: could not replace with its rebuilt artifact ({s}); left as is\n", .{ failure.domain, failure.version, @errorName(failure.err) });
    }
    // Adopting an unmarked copy changes nothing on disk but its marker.
    if (verbose and report.adopted > 0)
        style.print("  {s}{d} installed package(s) recorded as their current artifact, nothing re-fetched{s}\n", .{ style.dim, report.adopted, style.reset });
}

/// The frozen-lockfile failure: every locked hash the registry no longer
/// serves, with both hashes, and nothing installed.
fn frozenMismatchResult(allocator: std.mem.Allocator, mismatches: []const artifact_refresh.Mismatch) !types.CommandResult {
    const key = platform.binaryRegistryKey(platform.Platform.current(), platform.Architecture.current());
    var message: std.ArrayList(u8) = .empty;
    errdefer message.deinit(allocator);
    try message.appendSlice(allocator, "Error: lockfile is out of date (--frozen-lockfile): the registry rebuilt locked artifacts in place");
    for (mismatches) |m| {
        const locked = artifact_refresh.formatIntegrity(m.locked);
        const served = artifact_refresh.formatIntegrity(m.registry);
        style.printWarn("{s}@{s}: pantry.lock has {s}, but the registry now serves {s} for {s}\n", .{ m.domain, m.version, &locked, &served, key });
        try message.print(allocator, "\n  {s}@{s}: locked {s}, registry {s} ({s})", .{ m.domain, m.version, &locked, &served, key });
    }
    try message.appendSlice(allocator, "\nRun `pantry install` without --frozen-lockfile to install the rebuilt artifacts and record their hashes.");
    return .{ .exit_code = 1, .message = try message.toOwnedSlice(allocator) };
}

/// The project root an install works in: the workspace root, else the
/// directory of the nearest dependency file, else `cwd`. Caller owns it.
fn projectRoot(allocator: std.mem.Allocator, cwd: []const u8) ![]const u8 {
    const detector = @import("../../../deps/detector.zig");
    if (detector.findWorkspaceFile(allocator, cwd) catch null) |ws| {
        allocator.free(ws.path);
        return ws.root_dir;
    }
    if (detector.findDepsFile(allocator, cwd) catch null) |df| {
        defer allocator.free(df.path);
        return allocator.dupe(u8, std.fs.path.dirname(df.path) orelse cwd);
    }
    return allocator.dupe(u8, cwd);
}

/// Replace the project's registry binaries whose artifact the registry has
/// rebuilt in place, and record their hashes in pantry.lock, before the
/// install proper (and its up-to-date fast path) decides anything.
/// Returns a failed result only for a frozen lock the registry no longer
/// matches; anything else that goes wrong leaves the tree as it was.
pub fn refreshProject(allocator: std.mem.Allocator, options: types.InstallOptions) !?types.CommandResult {
    if (offline.isOfflineMode()) return null;
    const cwd = io_helper.getCwdAlloc(allocator) catch return null;
    defer allocator.free(cwd);
    const root = projectRoot(allocator, cwd) catch return null;
    defer allocator.free(root);

    const lock_path = try std.fs.path.join(allocator, &.{ root, "pantry.lock" });
    defer allocator.free(lock_path);
    const tree = try std.fs.path.join(allocator, &.{ root, options.modules_dir });
    defer allocator.free(tree);
    const has_lock = if (io_helper.accessAbsolute(lock_path, .{})) |_| true else |_| false;
    const has_tree = if (io_helper.accessAbsolute(tree, .{})) |_| true else |_| false;
    if (!has_lock and !has_tree) return null;

    var pkg_cache = lib.cache.PackageCache.init(allocator) catch return null;
    defer pkg_cache.deinit();
    var installer = install.Installer.init(allocator, &pkg_cache) catch return null;
    defer installer.deinit();
    installer.modules_dir = options.modules_dir;
    installer.verbose = options.verbose;
    var context = Hooks.init(&installer, root, options.verbose);
    defer context.deinit();

    const report = artifact_refresh.reconcile(allocator, .{
        .tree = tree,
        .lock_path = if (has_lock) lock_path else null,
        .frozen = options.frozen_lockfile,
        .save_lockfile = !options.no_save,
    }, context.hooks()) catch |err| {
        if (options.verbose) style.print("  ! Could not check for rebuilt artifacts: {s}\n", .{@errorName(err)});
        return null;
    };
    defer report.deinit(allocator);
    if (report.mismatches.len > 0) return try frozenMismatchResult(allocator, report.mismatches);
    printReport(report, options.verbose);
    return null;
}

/// `refreshProject` for a global install: the packages it names (by domain)
/// in `<global_dir>/packages`, through the installer the install uses.
pub fn refreshGlobal(allocator: std.mem.Allocator, installer: *install.Installer, global_dir: []const u8, names: []const []const u8) void {
    if (offline.isOfflineMode() or names.len == 0) return;
    const tree = std.fs.path.join(allocator, &.{ global_dir, "packages" }) catch return;
    defer allocator.free(tree);
    io_helper.accessAbsolute(tree, .{}) catch return;
    var context = Hooks.init(installer, null, installer.verbose);
    defer context.deinit();
    const report = artifact_refresh.reconcile(allocator, .{ .tree = tree, .only_domains = names }, context.hooks()) catch |err| {
        if (installer.verbose) style.print("  ! Could not check for rebuilt artifacts: {s}\n", .{@errorName(err)});
        return;
    };
    defer report.deinit(allocator);
    printReport(report, installer.verbose);
}
