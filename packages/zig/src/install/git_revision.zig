//! Git identities are checked before cache reuse and atomic publication.
const std = @import("std");
const io = @import("../io_helper.zig");
const staging = @import("verified_staging.zig");
const materialization = @import("materialization.zig");

fn readGit(allocator: std.mem.Allocator, args: []const []const u8, report: bool) ![]const u8 {
    const result = try io.childRun(allocator, args);
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    if (result.term != .exited or result.term.exited != 0) {
        if (report) std.debug.print("[pantry:git] {s}\n", .{result.stderr});
        return error.GitRevisionUnavailable;
    }
    return allocator.dupe(u8, std.mem.trim(u8, result.stdout, " \r\n\t"));
}

fn runGit(allocator: std.mem.Allocator, args: []const []const u8, report: bool) !void {
    const value = try readGit(allocator, args, report);
    allocator.free(value);
}

fn isObjectId(value: []const u8) bool {
    if (value.len != 40 and value.len != 64) return false;
    for (value) |byte| _ = std.fmt.charToDigit(byte, 16) catch return false;
    return true;
}

fn head(allocator: std.mem.Allocator, directory: []const u8) ![]const u8 {
    return readGit(allocator, &.{ "git", "-C", directory, "rev-parse", "--verify", "HEAD^{commit}" }, false);
}

fn cleanAt(allocator: std.mem.Allocator, directory: []const u8, url: []const u8, commit: []const u8) bool {
    const actual = head(allocator, directory) catch return false;
    defer allocator.free(actual);
    if (!std.ascii.eqlIgnoreCase(actual, commit)) return false;
    // Config retains the requested source identity rather than expanding Git's
    // transport rewrites (also used by owned local Git test servers).
    const configured = readGit(allocator, &.{ "git", "-C", directory, "config", "--local", "--get", "remote.origin.url" }, false) catch return false;
    defer allocator.free(configured);
    if (!std.mem.eql(u8, configured, url)) return false;
    const status = readGit(allocator, &.{ "git", "-C", directory, "status", "--porcelain", "--untracked-files=no" }, false) catch return false;
    defer allocator.free(status);
    return status.len == 0;
}

pub fn isCurrent(allocator: std.mem.Allocator, directory: []const u8, url: []const u8, requested: []const u8) bool {
    const ref = if (std.mem.eql(u8, requested, "latest") or std.mem.eql(u8, requested, "*")) "HEAD" else requested;
    if (isObjectId(ref)) {
        const expression = std.fmt.allocPrint(allocator, "{s}^{{commit}}", .{ref}) catch return false;
        defer allocator.free(expression);
        const commit = readGit(allocator, &.{ "git", "-C", directory, "rev-parse", "--verify", expression }, false) catch return false;
        defer allocator.free(commit);
        return cleanAt(allocator, directory, url, commit);
    }
    const recorded_ref = readGit(allocator, &.{ "git", "-C", directory, "config", "--local", "--get", "pantry.requested-ref" }, false) catch return false;
    defer allocator.free(recorded_ref);
    if (!std.mem.eql(u8, recorded_ref, ref)) return false;
    const commit = readGit(allocator, &.{ "git", "-C", directory, "config", "--local", "--get", "pantry.resolved-commit" }, false) catch return false;
    defer allocator.free(commit);
    return cleanAt(allocator, directory, url, commit);
}

/// Return true only when an already-installed snapshot was proved reusable.
/// A failed explicit fetch never falls through to the remote's default HEAD.
pub fn install(allocator: std.mem.Allocator, url: []const u8, requested: []const u8, destination: []const u8, force: bool, quiet: bool, operations: anytype) !bool {
    const ref = if (std.mem.eql(u8, requested, "latest") or std.mem.eql(u8, requested, "*")) "HEAD" else requested;
    if (ref.len == 0 or ref[0] == '-' or std.mem.indexOfScalar(u8, ref, 0) != null) return error.InvalidGitReference;
    if (!force and isCurrent(allocator, destination, url, ref)) return true;

    var temporary = try staging.Extraction.init(allocator, std.fs.path.dirname(destination) orelse ".");
    defer temporary.deinit();
    try runGit(allocator, &.{ "git", "clone", "--quiet", "--no-checkout", "--depth", "1", "--", url, temporary.payload }, !quiet);
    if (!std.mem.eql(u8, ref, "HEAD")) {
        try runGit(allocator, &.{ "git", "-C", temporary.payload, "fetch", "--quiet", "--no-tags", "--depth", "1", "origin", ref }, !quiet);
        if (isObjectId(ref)) {
            const fetched = try readGit(allocator, &.{ "git", "-C", temporary.payload, "rev-parse", "--verify", "FETCH_HEAD" }, !quiet);
            defer allocator.free(fetched);
            if (!std.ascii.eqlIgnoreCase(ref, fetched)) return error.GitRevisionMismatch;
        }
    }
    const checkout = if (std.mem.eql(u8, ref, "HEAD")) "HEAD" else "FETCH_HEAD";
    try runGit(allocator, &.{ "git", "-C", temporary.payload, "checkout", "--quiet", "--detach", checkout }, !quiet);
    const commit = try head(allocator, temporary.payload);
    defer allocator.free(commit);
    try runGit(allocator, &.{ "git", "-C", temporary.payload, "config", "--local", "pantry.requested-ref", ref }, !quiet);
    try runGit(allocator, &.{ "git", "-C", temporary.payload, "config", "--local", "pantry.resolved-commit", commit }, !quiet);

    const Validation = struct {
        allocator: std.mem.Allocator,
        url: []const u8,
        commit: []const u8,
        pub fn check(self: *const @This(), directory: []const u8) bool {
            return cleanAt(self.allocator, directory, self.url, self.commit);
        }
    };
    const validation = Validation{ .allocator = allocator, .url = url, .commit = commit };
    // Git verifies its own object identity; this is not an archive extraction
    // token. Copy the immutable snapshot through the existing checked atomic
    // transaction, then remove only this invocation's private clone.
    _ = try materialization.publish(allocator, .{ .shared = temporary.payload }, destination, &validation, operations);
    return false;
}
