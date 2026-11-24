const std = @import("std");
const io_helper = @import("../io_helper.zig");
const platform_core = @import("../core/platform.zig");
const style = @import("../cli/style.zig");
pub const registry_versions = @import("registry_versions.zig");

pub const DownloadError = error{
    HttpRequestFailed,
    PaymentRequired,
    InvalidUrl,
    FileWriteFailed,
    NetworkError,
    MaxRetriesExceeded,
    ChecksumMismatch,
};

pub const DownloadOptions = struct {
    // Total GET attempts, including the initial request. Header and body
    // recovery consume this same limit rather than nesting retry loops.
    max_retries: u32 = 3,
    initial_retry_delay_ms: u64 = 1000,
};

/// Format bytes to human readable format (e.g., "12.3 MB")
fn formatBytes(bytes: u64, buf: []u8) ![]const u8 {
    if (bytes == 0) {
        return std.fmt.bufPrint(buf, "0 B", .{});
    }

    const k: f64 = 1024.0;
    const sizes = [_][]const u8{ "B", "KB", "MB", "GB", "TB" };

    // Calculate the appropriate unit (with safety for edge cases)
    const bytes_f = @as(f64, @floatFromInt(bytes));
    const log_val = @log(bytes_f) / @log(k);
    const clamped = @max(0.0, @min(log_val, @as(f64, @floatFromInt(sizes.len - 1))));
    const i = @as(usize, @intFromFloat(@floor(clamped)));
    const size_idx = @min(i, sizes.len - 1);

    const value = bytes_f / std.math.pow(f64, k, @as(f64, @floatFromInt(size_idx)));

    return std.fmt.bufPrint(buf, "{d:.1} {s}", .{ value, sizes[size_idx] });
}

/// Format speed (bytes per second)
fn formatSpeed(bytes_per_sec: u64, buf: []u8) ![]const u8 {
    var size_buf: [64]u8 = undefined;
    const size_str = try formatBytes(bytes_per_sec, &size_buf);
    return std.fmt.bufPrint(buf, "{s}/s", .{size_str});
}

/// Download a file from a URL to a destination path with progress
pub fn downloadFile(allocator: std.mem.Allocator, url: []const u8, dest_path: []const u8) !void {
    return downloadFileWithOptions(allocator, url, dest_path, false, null);
}

/// Download a file from a URL to a destination path with optional quiet mode
pub fn downloadFileQuiet(allocator: std.mem.Allocator, url: []const u8, dest_path: []const u8, quiet: bool) !void {
    return downloadFileWithOptions(allocator, url, dest_path, quiet, null);
}

/// Download progress callback options for inline progress display
pub const InlineProgressOptions = struct {
    line_offset: usize, // How many lines up from current position
    total_deps: usize, // Total number of dependencies
    pkg_name: []const u8, // Package name to display
    pkg_version: []const u8, // Package version to display
};

/// Download with inline progress (updates a specific line instead of new lines)
pub fn downloadFileInline(allocator: std.mem.Allocator, url: []const u8, dest_path: []const u8, progress_opts: InlineProgressOptions) !void {
    return downloadFileWithOptions(allocator, url, dest_path, false, progress_opts);
}

fn downloadFileWithOptions(allocator: std.mem.Allocator, url: []const u8, dest_path: []const u8, quiet: bool, inline_progress: ?InlineProgressOptions) !void {
    return io_helper.runDownloadWithRetry(downloadFileTask, .{ allocator, url, dest_path, quiet, inline_progress }, dest_path, .{});
}

fn reportArchiveFailure(stream: *io_helper.HttpStream, file: std.Io.File, stage: []const u8, cause: anyerror, expected: ?u64) void {
    if (cause == error.Canceled) return;
    io_helper.printGetFailure(stream.request_url, stage, cause);
    // Only persisted bytes are counted. A writer's unflushed buffer is not
    // evidence that the filesystem accepted those bytes.
    const metadata = file.stat(io_helper.io) catch return;
    if (expected) |length| {
        style.printForced("  [pantry:download] persisted bytes={d} expected={d}\n", .{ metadata.size, length });
    } else {
        style.printForced("  [pantry:download] persisted bytes={d} expected=unknown\n", .{metadata.size});
    }
}

fn downloadFileTask(allocator: std.mem.Allocator, url: []const u8, dest_path: []const u8, quiet: bool, inline_progress: ?InlineProgressOptions, budget: *io_helper.HttpGetRetryBudget, created: *bool, body_failure: *bool) anyerror!void {
    // Validate URL format
    if (!std.mem.startsWith(u8, url, "http://") and !std.mem.startsWith(u8, url, "https://")) {
        style.printInvalidUrl(url);
        return error.InvalidUrl;
    }

    // The native transport owns redirect lifetimes and recomputes credentials
    // per origin. Preserve its typed failures rather than invoking a second
    // downloader with different endpoint and authentication behavior.
    var stream = try io_helper.httpStreamGetWithRetryBudget(allocator, url, budget);
    defer stream.deinit();

    const total_bytes = stream.contentLength();

    // Create output file
    const file = io_helper.cwd().createFile(io_helper.io, dest_path, .{}) catch |err| {
        io_helper.printGetFailure(stream.request_url, "archive-create", err);
        return err;
    };
    created.* = true;
    defer file.close(io_helper.io);

    // Perf: 128KB file write buffer + 64KB transfer buffer for better throughput
    var file_buf: [131072]u8 = undefined;
    var file_writer = file.writerStreaming(io_helper.io, &file_buf);

    // Stream response body to file with progress tracking
    var transfer_buf: [65536]u8 = undefined;
    const body_reader = stream.reader(&transfer_buf);

    const start_ts = io_helper.clockGettime();
    const start_ms = @as(i64, @intCast(start_ts.sec)) * 1000 + @divFloor(@as(i64, @intCast(start_ts.nsec)), 1_000_000);
    var bytes_downloaded: u64 = 0;
    var last_update_ms: i64 = start_ms;
    var shown_progress = false;

    while (true) {
        const n = body_reader.stream(&file_writer.interface, .unlimited) catch |err| switch (err) {
            error.EndOfStream => break,
            else => {
                const cause = if (err == error.WriteFailed) file_writer.err orelse err else stream.readError(err);
                body_failure.* = err != error.WriteFailed;
                reportArchiveFailure(stream, file, if (err == error.WriteFailed) "archive-write" else "response-body", cause, total_bytes);
                return cause;
            },
        };
        bytes_downloaded += n;

        // Update progress display (skip if quiet mode or CI)
        if (!quiet and !style.isCI()) {
            const now_ts = io_helper.clockGettime();
            const now_ms = @as(i64, @intCast(now_ts.sec)) * 1000 + @divFloor(@as(i64, @intCast(now_ts.nsec)), 1_000_000);

            if (now_ms - last_update_ms >= 100) {
                if (inline_progress) |opts| {
                    // Inline progress: update the package line
                    const lines_up = if (opts.total_deps > opts.line_offset) opts.total_deps - opts.line_offset else 0;
                    var current_buf: [32]u8 = undefined;
                    const current_str = formatBytes(bytes_downloaded, &current_buf) catch "?";

                    style.moveUp(lines_up);
                    style.clearLine();
                    if (total_bytes) |total| {
                        var total_buf: [32]u8 = undefined;
                        const total_str = formatBytes(total, &total_buf) catch "?";
                        style.print("{s}+{s} {s}@{s}{s}{s} {s}({s}/{s}){s}\n", .{
                            style.dim,     style.reset,
                            opts.pkg_name, style.dim,
                            style.italic,  opts.pkg_version,
                            style.dim,     current_str,
                            total_str,     style.reset,
                        });
                    } else {
                        style.print("{s}+{s} {s}@{s}{s}{s} {s}({s}){s}\n", .{
                            style.dim,     style.reset,
                            opts.pkg_name, style.dim,
                            style.italic,  opts.pkg_version,
                            style.dim,     current_str,
                            style.reset,
                        });
                    }
                    if (opts.total_deps > 0 and opts.line_offset < opts.total_deps - 1 and lines_up > 0) {
                        style.moveDown(lines_up - 1);
                    }
                } else {
                    // Standard progress line
                    var current_buf: [32]u8 = undefined;
                    const current_str = formatBytes(bytes_downloaded, &current_buf) catch "?";
                    const elapsed_sec = @as(f64, @floatFromInt(now_ms - start_ms)) / 1000.0;

                    if (elapsed_sec > 0.1) {
                        const speed = @as(f64, @floatFromInt(bytes_downloaded)) / elapsed_sec;
                        var speed_buf: [32]u8 = undefined;
                        const speed_str = formatSpeed(@intFromFloat(speed), &speed_buf) catch null;

                        const total_str: ?[]const u8 = if (total_bytes) |total| blk: {
                            var tbuf: [32]u8 = undefined;
                            break :blk formatBytes(total, &tbuf) catch null;
                        } else null;

                        style.printDownloadProgress(current_str, total_str, speed_str, !shown_progress);
                        if (!shown_progress) shown_progress = true;
                    } else {
                        style.printDownloadProgress(current_str, null, null, !shown_progress);
                        if (!shown_progress) shown_progress = true;
                    }
                }
                last_update_ms = now_ms;
            }
        }
    }

    // Flush remaining buffered data to disk
    file_writer.flush() catch |err| {
        const cause = file_writer.err orelse err;
        reportArchiveFailure(stream, file, "archive-flush", cause, total_bytes);
        return cause;
    };

    // Verify download completeness: if Content-Length was provided, check downloaded bytes match
    if (total_bytes) |expected| {
        if (bytes_downloaded != expected) {
            body_failure.* = true;
            reportArchiveFailure(stream, file, "archive-length", error.IncompleteDownload, total_bytes);
            return error.IncompleteDownload;
        }
    }

    // Clear progress line (let caller print final status)
    if (!quiet and shown_progress) {
        style.clearLine();
    }
}

/// Check if a version string looks like a Zig dev version
pub fn isZigDevVersion(version: []const u8) bool {
    // Dev versions look like: 0.16.0-dev.1484+d0ba6642b, 0.14.0-dev.2851+b074a1eb8, or 0.16.0-dev
    return std.mem.indexOf(u8, version, "-dev") != null;
}

/// Check if a version is a short dev specifier (e.g. "0.16.0-dev") that needs resolution
fn isShortDevVersion(version: []const u8) bool {
    return std.mem.endsWith(u8, version, "-dev");
}

/// Resolve a Zig version specifier to a concrete Pantry registry version.
/// Handles:
///   - "*" / "latest" → latest stable release (e.g. "0.15.2")
///   - Short dev like "0.16.0-dev" → full dev version (e.g. "0.16.0-dev.1484+d0ba6642b")
///   - Anything else → returned as-is
pub fn resolveZigDevVersion(allocator: std.mem.Allocator, version: []const u8) ![]const u8 {
    return resolveZigVersionUsing(allocator, version, lookupS3Registry, lookupZiglangIndexVersion);
}

fn resolveZigVersionUsing(allocator: std.mem.Allocator, version: []const u8, comptime registry: anytype, comptime upstream: anytype) ![]const u8 {
    const semver = @import("../packages/semver.zig");
    const is_wildcard = std.mem.eql(u8, version, "*") or std.mem.eql(u8, version, "latest");
    const is_short_dev = isShortDevVersion(version);
    const is_range = semver.isSemverRange(version);

    if (!is_wildcard and !is_short_dev and !is_range) return allocator.dupe(u8, version);

    if (try registry(allocator, "ziglang.org", version)) |result| {
        allocator.free(result.tarball_url);
        return result.version;
    }

    if (upstream(allocator, version)) |resolved| return resolved;

    return allocator.dupe(u8, version);
}

/// Parse "major.minor.patch" into numeric parts for comparison
fn parseVersionParts(v: []const u8) [3]u32 {
    var parts: [3]u32 = .{ 0, 0, 0 };
    var i: usize = 0;
    var it = std.mem.splitScalar(u8, v, '.');
    while (it.next()) |seg| {
        if (i >= 3) break;
        parts[i] = std.fmt.parseInt(u32, seg, 10) catch 0;
        i += 1;
    }
    return parts;
}

fn compareParts(a: [3]u32, b: [3]u32) std.math.Order {
    for (0..3) |i| {
        if (a[i] != b[i]) return std.math.order(a[i], b[i]);
    }
    return .eq;
}

/// Build the canonical Pantry registry URL for a mirrored Zig archive.
pub fn buildZiglangUrl(
    allocator: std.mem.Allocator,
    version: []const u8,
) ![]const u8 {
    const platform = platform_core.Platform.current();
    const platform_str = switch (platform) {
        .darwin => "darwin",
        .linux => "linux",
        .windows => "windows",
        .freebsd => "freebsd",
    };

    const arch = platform_core.Architecture.current();
    const arch_str = switch (arch) {
        .x86_64 => "x86-64",
        .aarch64 => "arm64",
    };

    const ext = if (platform == .windows) "zip" else "tar.gz";
    return std.fmt.allocPrint(
        allocator,
        "https://registry.pantry.dev/binaries/ziglang.org/{s}/{s}-{s}/ziglang.org-{s}.{s}",
        .{ version, platform_str, arch_str, version, ext },
    );
}

/// Build an official ziglang.org archive URL for use when the Pantry binary
/// mirror is unavailable. Pantry registry versions replace `+` with `_` in
/// build metadata, so normalize that separator before addressing upstream.
pub fn buildZiglangFallbackUrl(
    allocator: std.mem.Allocator,
    version: []const u8,
) ![]const u8 {
    const platform = switch (platform_core.Platform.current()) {
        .darwin => "macos",
        .linux => "linux",
        .windows => "windows",
        .freebsd => "freebsd",
    };
    const arch = switch (platform_core.Architecture.current()) {
        .x86_64 => "x86_64",
        .aarch64 => "aarch64",
    };
    const ext = if (platform_core.Platform.current() == .windows) "zip" else "tar.xz";

    const upstream_version = try allocator.dupe(u8, version);
    defer allocator.free(upstream_version);
    if (std.mem.indexOfScalar(u8, upstream_version, '_')) |idx| upstream_version[idx] = '+';

    if (isZigDevVersion(upstream_version)) {
        return std.fmt.allocPrint(
            allocator,
            "https://ziglang.org/builds/zig-{s}-{s}-{s}.{s}",
            .{ arch, platform, upstream_version, ext },
        );
    }
    return std.fmt.allocPrint(
        allocator,
        "https://ziglang.org/download/{s}/zig-{s}-{s}-{s}.{s}",
        .{ upstream_version, arch, platform, upstream_version, ext },
    );
}

/// Build package download URL
pub fn buildPackageUrl(
    allocator: std.mem.Allocator,
    domain: []const u8,
    version: []const u8,
    format: []const u8,
) ![]const u8 {
    const platform = platform_core.Platform.current();
    const platform_str = switch (platform) {
        .darwin => "darwin",
        .linux => "linux",
        .windows => "windows",
        .freebsd => "freebsd",
    };

    const arch = platform_core.Architecture.current();
    const arch_str = switch (arch) {
        .x86_64 => "x86-64",
        .aarch64 => "aarch64",
    };

    // pkgx uses format: https://dist.pkgx.dev/{domain}/{platform}/{arch}/v{version}.tar.xz
    // Strip semver prefixes (^, ~, >=, etc.) and 'v' prefix
    var clean_version = version;

    // Strip semver constraint prefixes
    if (std.mem.startsWith(u8, clean_version, "^") or
        std.mem.startsWith(u8, clean_version, "~") or
        std.mem.startsWith(u8, clean_version, "="))
    {
        clean_version = clean_version[1..];
    } else if (std.mem.startsWith(u8, clean_version, ">=") or
        std.mem.startsWith(u8, clean_version, "<="))
    {
        clean_version = clean_version[2..];
    } else if (std.mem.startsWith(u8, clean_version, ">") or
        std.mem.startsWith(u8, clean_version, "<"))
    {
        clean_version = clean_version[1..];
    }

    // Strip 'v' prefix if present
    if (std.mem.startsWith(u8, clean_version, "v")) {
        clean_version = clean_version[1..];
    }

    // If version is just a major version like "22", try with .0.0
    const needs_full_version = std.mem.indexOf(u8, clean_version, ".") == null;
    const full_version = if (needs_full_version)
        try std.fmt.allocPrint(allocator, "{s}.0.0", .{clean_version})
    else
        clean_version;
    defer if (needs_full_version) allocator.free(full_version);

    return std.fmt.allocPrint(
        allocator,
        "https://dist.pkgx.dev/{s}/{s}/{s}/v{s}.{s}",
        .{ domain, platform_str, arch_str, full_version, format },
    );
}

/// S3 registry lookup result
pub const S3PackageResult = struct {
    tarball_url: []const u8,
    version: []const u8,
    archive_identity: ?@import("archive_resume.zig").Identity = null,
    /// When the registry last wrote this platform's artifact (its
    /// `uploadedAt`), in milliseconds since the epoch; null when unrecorded.
    uploaded_at_ms: ?i64 = null,
};

/// `2026-11-08T00:10:34.134Z` (an RFC 3339 / ISO 8601 UTC timestamp, the
/// form the registry writes `uploadedAt` in, fraction and offset optional)
/// as milliseconds since the epoch; null for anything else.
pub fn parseTimestampMs(text: []const u8) ?i64 {
    const t = std.mem.trim(u8, text, &std.ascii.whitespace);
    if (t.len < 19 or t[4] != '-' or t[7] != '-' or (t[10] != 'T' and t[10] != 't' and t[10] != ' ') or t[13] != ':' or t[16] != ':') return null;
    const year = std.fmt.parseInt(i64, t[0..4], 10) catch return null;
    const month = std.fmt.parseInt(i64, t[5..7], 10) catch return null;
    const day = std.fmt.parseInt(i64, t[8..10], 10) catch return null;
    const hour = std.fmt.parseInt(i64, t[11..13], 10) catch return null;
    const minute = std.fmt.parseInt(i64, t[14..16], 10) catch return null;
    const second = std.fmt.parseInt(i64, t[17..19], 10) catch return null;
    if (month < 1 or month > 12 or day < 1 or day > 31 or hour > 23 or minute > 59 or second > 60) return null;
    var i: usize = 19;
    var millis: i64 = 0;
    if (i < t.len and t[i] == '.') {
        i += 1;
        var scale: i64 = 100;
        const start = i;
        while (i < t.len and std.ascii.isDigit(t[i])) : (i += 1) {
            millis += (t[i] - '0') * scale;
            scale = @divTrunc(scale, 10);
        }
        if (i == start) return null;
    }
    var offset_minutes: i64 = 0;
    if (i < t.len) {
        switch (t[i]) {
            'Z', 'z' => i += 1,
            '+', '-' => {
                if (t.len < i + 6 or t[i + 3] != ':') return null;
                const oh = std.fmt.parseInt(i64, t[i + 1 .. i + 3], 10) catch return null;
                const om = std.fmt.parseInt(i64, t[i + 4 .. i + 6], 10) catch return null;
                offset_minutes = (oh * 60 + om) * (if (t[i] == '-') @as(i64, -1) else 1);
                i += 6;
            },
            else => return null,
        }
    }
    if (i != t.len) return null;
    // Days from the civil date (Howard Hinnant's algorithm).
    const y = if (month <= 2) year - 1 else year;
    const era = @divFloor(y, 400);
    const yoe = y - era * 400;
    const mp = @mod(month + 9, 12);
    const doy = @divFloor(153 * mp + 2, 5) + day - 1;
    const doe = yoe * 365 + @divFloor(yoe, 4) - @divFloor(yoe, 100) + doy;
    const days = era * 146097 + doe - 719468;
    const seconds = days * 86400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
    return seconds * 1000 + millis;
}

test "registry uploadedAt timestamps parse to epoch milliseconds" {
    try std.testing.expectEqual(@as(?i64, 0), parseTimestampMs("1970-01-01T00:00:00Z"));
    try std.testing.expectEqual(@as(?i64, 1762560634134), parseTimestampMs("2025-11-08T00:10:34.134Z"));
    try std.testing.expectEqual(@as(?i64, 1762560634000), parseTimestampMs("2025-11-08T01:10:34+01:00"));
    try std.testing.expectEqual(@as(?i64, 951782400000), parseTimestampMs("2000-02-29T00:00:00Z"));
    try std.testing.expect(parseTimestampMs("") == null);
    try std.testing.expect(parseTimestampMs("2025-11-08") == null);
    try std.testing.expect(parseTimestampMs("2025-13-08T00:00:00Z") == null);
    try std.testing.expect(parseTimestampMs("2025-11-08T00:10:34.134Zjunk") == null);
}

fn zigDevBuildNumber(version: []const u8) ?u64 {
    const marker = "-dev.";
    const start = (std.mem.indexOf(u8, version, marker) orelse return null) + marker.len;
    var end = start;
    while (end < version.len and std.ascii.isDigit(version[end])) : (end += 1) {}
    if (end == start) return null;
    return std.fmt.parseInt(u64, version[start..end], 10) catch null;
}

/// Resolve a Zig range through the official download index when Pantry's
/// binary metadata endpoint is unavailable.
fn lookupZiglangIndexVersion(allocator: std.mem.Allocator, version_constraint: []const u8) ?[]const u8 {
    const semver = @import("../packages/semver.zig");
    const constraint = semver.parseConstraint(version_constraint) catch return null;
    const response = io_helper.httpGet(allocator, "https://ziglang.org/download/index.json") catch return null;
    defer allocator.free(response);

    const parsed = std.json.parseFromSlice(std.json.Value, allocator, response, .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;

    var best: ?[]const u8 = null;
    var best_parsed: ?semver.Version = null;
    var it = parsed.value.object.iterator();
    while (it.next()) |entry| {
        const version_value = if (std.mem.eql(u8, entry.key_ptr.*, "master"))
            if (entry.value_ptr.* == .object) entry.value_ptr.*.object.get("version") orelse continue else continue
        else
            std.json.Value{ .string = entry.key_ptr.* };
        if (version_value != .string) continue;
        const candidate = version_value.string;
        if (!semver.satisfiesConstraint(candidate, constraint)) continue;
        const candidate_parsed = semver.parseVersion(candidate) catch continue;

        if (best_parsed) |current| {
            const newer_dev = candidate_parsed.major == current.major and
                candidate_parsed.minor == current.minor and
                candidate_parsed.patch == current.patch and
                (zigDevBuildNumber(candidate) orelse 0) > (zigDevBuildNumber(best.?) orelse 0);
            const newer_release = candidate_parsed.major > current.major or
                (candidate_parsed.major == current.major and candidate_parsed.minor > current.minor) or
                (candidate_parsed.major == current.major and candidate_parsed.minor == current.minor and
                    candidate_parsed.patch > current.patch);
            if (!newer_dev and !newer_release) continue;
        }
        best = candidate;
        best_parsed = candidate_parsed;
    }

    return allocator.dupe(u8, best orelse return null) catch null;
}

/// Try to find a package tarball in the pantry S3 registry.
/// Fetches metadata.json, resolves version constraint, returns download URL.
/// Only confirmed absence returns null; transport, status and schema errors propagate.
pub fn lookupS3Registry(
    allocator: std.mem.Allocator,
    domain: []const u8,
    version_constraint: []const u8,
) !?S3PackageResult {
    if (metadata_cache.get(allocator, domain)) |cached| {
        defer if (cached) |body| allocator.free(body);
        const body = cached orelse return null;
        return selectS3RegistryMetadata(allocator, version_constraint, body);
    }
    const metadata_url = try std.fmt.allocPrint(allocator, "https://registry.pantry.dev/binaries/{s}/metadata.json", .{domain});
    defer allocator.free(metadata_url);
    const response = try io_helper.httpGetStatusTimeout(allocator, metadata_url, 30_000);
    defer response.deinit(allocator);
    if (response.status == 404) {
        metadata_cache.put(domain, null);
        return null;
    }
    if (!response.ok()) {
        style.print("  Registry metadata HTTP {d} for {s}\n", .{ response.status, domain });
        return if (response.status == 401 or response.status == 403) error.RegistryAuthenticationRequired else error.RegistryUnavailable;
    }
    metadata_cache.put(domain, response.body);
    return selectS3RegistryMetadata(allocator, version_constraint, response.body);
}

/// One `metadata.json` per package per run.
///
/// An install asks about the same package several times: the artifact check
/// before the install (install/artifact_refresh.zig) compares every installed
/// package's sha256 with the registry's, and the reinstall it may start, the
/// dependency walk and the resolver then look the same package up again. Each
/// answer is kept briefly so those are one request, not four. Only a 200 or a
/// 404 is kept; a failure is asked again. Entries expire, so a long-lived
/// process does not go on reading an artifact the registry has since replaced.
const metadata_cache = struct {
    const ttl_ms: i64 = 60_000;
    const Entry = struct { body: ?[]u8, fetched_ms: i64 };

    var mutex: io_helper.Mutex = .{};
    var entries: std.StringHashMapUnmanaged(Entry) = .empty;
    // Process-lifetime storage, independent of whichever allocator a caller
    // (possibly a leak-checking test allocator) happens to pass.
    const storage = std.heap.smp_allocator;

    fn nowMs() i64 {
        const ts = io_helper.clockGettimeMonotonic();
        return @as(i64, @intCast(ts.sec)) * 1000 + @divFloor(@as(i64, @intCast(ts.nsec)), 1_000_000);
    }

    /// null: not cached. Some(null): the registry answered 404. Some(body):
    /// a copy of the body owned by the caller.
    fn get(allocator: std.mem.Allocator, domain: []const u8) ??[]u8 {
        mutex.lock();
        defer mutex.unlock();
        const entry = entries.get(domain) orelse return null;
        if (nowMs() - entry.fetched_ms > ttl_ms) return null;
        const body = entry.body orelse return @as(?[]u8, null);
        return allocator.dupe(u8, body) catch return null;
    }

    fn put(domain: []const u8, body: ?[]const u8) void {
        const owned_body: ?[]u8 = if (body) |b| (storage.dupe(u8, b) catch return) else null;
        mutex.lock();
        defer mutex.unlock();
        const gop = entries.getOrPut(storage, domain) catch {
            if (owned_body) |b| storage.free(b);
            return;
        };
        if (gop.found_existing) {
            if (gop.value_ptr.body) |old| storage.free(old);
        } else {
            gop.key_ptr.* = storage.dupe(u8, domain) catch {
                entries.removeByPtr(gop.key_ptr);
                if (owned_body) |b| storage.free(b);
                return;
            };
        }
        gop.value_ptr.* = .{ .body = owned_body, .fetched_ms = nowMs() };
    }
};

test "registry metadata is kept per package for the run" {
    const allocator = std.testing.allocator;
    try std.testing.expect(metadata_cache.get(allocator, "fixture.test/cache-miss") == null);
    metadata_cache.put("fixture.test/absent", null);
    const absent = metadata_cache.get(allocator, "fixture.test/absent").?;
    try std.testing.expect(absent == null);
    metadata_cache.put("fixture.test/present", "{\"versions\":{}}");
    metadata_cache.put("fixture.test/present", "{\"versions\":{\"1\":{}}}");
    const body = metadata_cache.get(allocator, "fixture.test/present").?.?;
    defer allocator.free(body);
    try std.testing.expectEqualStrings("{\"versions\":{\"1\":{}}}", body);
}

fn selectS3RegistryMetadata(allocator: std.mem.Allocator, version_constraint: []const u8, metadata: []const u8) !?S3PackageResult {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, metadata, .{}) catch return error.InvalidRegistryMetadata;
    defer parsed.deinit();
    const root = parsed.value;
    if (root != .object) return error.InvalidRegistryMetadata;
    const versions_obj = root.object.get("versions") orelse return error.InvalidRegistryMetadata;
    if (versions_obj != .object) return error.InvalidRegistryMetadata;
    var versions = versions_obj.object.iterator();
    while (versions.next()) |entry| {
        const version = entry.value_ptr.*;
        if (version != .object) return error.InvalidRegistryMetadata;
        const platforms = version.object.get("platforms") orelse return error.InvalidRegistryMetadata;
        if (platforms != .object) return error.InvalidRegistryMetadata;
        var entries = platforms.object.iterator();
        while (entries.next()) |platform| {
            const info = platform.value_ptr.*;
            if (info != .object) return error.InvalidRegistryMetadata;
            const tarball = info.object.get("tarball") orelse return error.InvalidRegistryMetadata;
            if (tarball != .string or std.mem.trim(u8, tarball.string, " \t\r\n").len == 0) return error.InvalidRegistryMetadata;
            if (info.object.get("sha256")) |checksum| {
                if (checksum != .string) return error.InvalidRegistryMetadata;
            }
        }
    }

    const platform = platform_core.binaryRegistryKey(platform_core.Platform.current(), platform_core.Architecture.current());

    // Only versions with a tarball for this platform are candidates, and
    // `latest` skips placeholders and prereleases — see registry_versions.zig.
    const selection = registry_versions.select(versions_obj.object, version_constraint, platform) orelse return null;
    const matched_version = selection.version;
    const platform_info = selection.platform_info;

    const tarball_path_val = platform_info.object.get("tarball") orelse return error.InvalidRegistryMetadata;
    const tarball_path = if (tarball_path_val == .string) tarball_path_val.string else return error.InvalidRegistryMetadata;

    // Download binary-registry artifacts via the registry proxy, which 302-
    // redirects to a (presigned, for private buckets) object URL — so large
    // prebuilt archives stream straight from object storage without being
    // buffered through the registry process. `tarball_path` already carries the
    // `binaries/...` prefix, so this resolves to registry.pantry.dev/binaries/…
    const tarball_url = try std.fmt.allocPrint(
        allocator,
        "https://registry.pantry.dev/{s}",
        .{tarball_path},
    );
    errdefer allocator.free(tarball_url);
    const version_dupe = try allocator.dupe(u8, matched_version);
    errdefer allocator.free(version_dupe);
    var archive_identity: ?@import("archive_resume.zig").Identity = null;
    if (platform_info.object.get("sha256")) |checksum| {
        if (platform_info.object.get("size")) |size| {
            if (checksum == .string and checksum.string.len == 64 and size == .integer and size.integer > 0) {
                var digest: [32]u8 = undefined;
                _ = std.fmt.hexToBytes(&digest, checksum.string) catch return error.InvalidRegistryMetadata;
                archive_identity = .{ .sha256 = digest, .size = @intCast(size.integer) };
            }
        }
    }

    const uploaded_at_ms: ?i64 = if (platform_info.object.get("uploadedAt")) |value|
        (if (value == .string) parseTimestampMs(value.string) else null)
    else
        null;

    return S3PackageResult{
        .tarball_url = tarball_url,
        .version = version_dupe,
        .archive_identity = archive_identity,
        .uploaded_at_ms = uploaded_at_ms,
    };
}

test "zig dev build numbers compare numerically" {
    try std.testing.expectEqual(@as(?u64, 1422), zigDevBuildNumber("0.17.0-dev.1422+e863bf3be"));
    try std.testing.expectEqual(@as(?u64, 986), zigDevBuildNumber("0.17.0-dev.986_f3544a707"));
    try std.testing.expectEqual(@as(?u64, null), zigDevBuildNumber("0.17.0"));
}

test "native archive resume: registry selection retains the complete immutable identity" {
    const allocator = std.testing.allocator;
    const platform = platform_core.binaryRegistryKey(platform_core.Platform.current(), platform_core.Architecture.current());
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("abcdefghij", &digest, .{});
    const metadata = try std.fmt.allocPrint(allocator,
        \\{{"versions":{{"1.0.0":{{"platforms":{{"{s}":{{"tarball":"binaries/fixture.tar.gz","sha256":"{s}","size":10,"uploadedAt":"2025-11-08T00:10:34.134Z"}}}}}}}}}}
    , .{ platform, std.fmt.bytesToHex(digest, .lower) });
    defer allocator.free(metadata);
    const selected = (try selectS3RegistryMetadata(allocator, "1.0.0", metadata)).?;
    defer allocator.free(selected.tarball_url);
    defer allocator.free(selected.version);
    try std.testing.expectEqual(@as(u64, 10), selected.archive_identity.?.size);
    try std.testing.expectEqualSlices(u8, &digest, &selected.archive_identity.?.sha256);
    try std.testing.expectEqualStrings("https://registry.pantry.dev/binaries/fixture.tar.gz", selected.tarball_url);
    try std.testing.expectEqual(@as(?i64, 1762560634134), selected.uploaded_at_ms);
}

// The resolver is a unit test, not an availability probe for the live
// registry. Use the production parser with controlled metadata; keep typed
// transport failures intact rather than hiding them behind upstream fallback.
const ZigResolutionFixture = struct {
    fn registry(allocator: std.mem.Allocator, domain: []const u8, constraint: []const u8) !?S3PackageResult {
        try std.testing.expectEqualStrings("ziglang.org", domain);
        const platform = platform_core.binaryRegistryKey(platform_core.Platform.current(), platform_core.Architecture.current());
        const metadata = try std.fmt.allocPrint(allocator,
            \\{{"versions":{{"0.17.0-dev.1422+fixture":{{"platforms":{{"{s}":{{"tarball":"binaries/zig-dev.tar.xz","sha256":"fixture"}}}}}},"0.17.0":{{"platforms":{{"{s}":{{"tarball":"binaries/zig-stable.tar.xz","sha256":"fixture"}}}}}},"0.18.0-dev.1+fixture":{{"platforms":{{"{s}":{{"tarball":"binaries/zig-next.tar.xz","sha256":"fixture"}}}}}}}}}}
        , .{ platform, platform, platform });
        defer allocator.free(metadata);
        return selectS3RegistryMetadata(allocator, constraint, metadata);
    }

    fn unexpectedUpstream(_: std.mem.Allocator, _: []const u8) ?[]const u8 {
        @panic("Registry results and failures must not reach upstream fallback");
    }

    fn absent(_: std.mem.Allocator, _: []const u8, _: []const u8) !?S3PackageResult {
        return null;
    }

    fn unavailable(_: std.mem.Allocator, _: []const u8, _: []const u8) !?S3PackageResult {
        return error.RegistryUnavailable;
    }

    fn upstream(allocator: std.mem.Allocator, _: []const u8) ?[]const u8 {
        return allocator.dupe(u8, "0.17.0") catch null;
    }
};

test "Zig prerelease ranges are resolved through registry metadata" {
    const allocator = std.testing.allocator;
    const resolved = try resolveZigVersionUsing(allocator, "^0.17.0-dev", ZigResolutionFixture.registry, ZigResolutionFixture.unexpectedUpstream);
    defer allocator.free(resolved);
    try std.testing.expectEqualStrings("0.17.0", resolved);
}

test "Zig resolution only falls back after confirmed registry absence" {
    const allocator = std.testing.allocator;
    const resolved = try resolveZigVersionUsing(allocator, "^0.17.0-dev", ZigResolutionFixture.absent, ZigResolutionFixture.upstream);
    defer allocator.free(resolved);
    try std.testing.expectEqualStrings("0.17.0", resolved);
    try std.testing.expectError(error.RegistryUnavailable, resolveZigVersionUsing(allocator, "^0.17.0-dev", ZigResolutionFixture.unavailable, ZigResolutionFixture.unexpectedUpstream));
}

/// Try to find a package tarball published via `pantry publish` (packages/pantry/ prefix).
/// This is the S3 path used by the standard `pantry publish` command.
/// Only confirmed absence or a valid nonmatching version returns null.
pub fn lookupPantryPublished(
    allocator: std.mem.Allocator,
    domain: []const u8,
    version_constraint: []const u8,
) !?S3PackageResult {
    const semver = @import("../packages/semver.zig");
    const pkg_registry = @import("../packages/generated.zig");

    // Resolve domain → package name (e.g. craft-native.org → craft)
    const pkg_info = pkg_registry.getPackageByDomain(domain);
    const pkg_name = if (pkg_info) |info| info.name else domain;

    // Also try the domain slug as fallback
    var sanitized_buf: [256]u8 = undefined;
    var slug_len: usize = 0;
    for (domain) |c| {
        if (slug_len >= sanitized_buf.len) break;
        sanitized_buf[slug_len] = if (c == '/' or c == '@') '-' else c;
        slug_len += 1;
    }
    const clean_name = if (slug_len > 0 and sanitized_buf[0] == '-') sanitized_buf[1..slug_len] else sanitized_buf[0..slug_len];
    _ = clean_name; // May be used for fallback later

    // Query registry API using package name (npm-style publish uses name, not domain)
    const metadata_url = try std.fmt.allocPrint(
        allocator,
        "https://registry.pantry.dev/packages/{s}",
        .{pkg_name},
    );
    defer allocator.free(metadata_url);

    const response = try io_helper.httpGetStatusTimeout(allocator, metadata_url, 30_000);
    defer response.deinit(allocator);
    if (response.status == 404) return null;
    if (!response.ok()) {
        style.print("  Registry package metadata HTTP {d} for {s}\n", .{ response.status, domain });
        return if (response.status == 401 or response.status == 403) error.RegistryAuthenticationRequired else error.RegistryUnavailable;
    }
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, response.body, .{}) catch return error.InvalidRegistryMetadata;
    defer parsed.deinit();
    const root = parsed.value;
    if (root != .object) return error.InvalidRegistryMetadata;

    // The npm namespace is not this namespace.
    //
    // This endpoint is a proxy: ask it for a name it does not publish and it
    // answers with npm's package of that name. Since the lookup above turns a
    // domain into its short name, `bun.com` asks for `bun` and gets npm's bun -
    // a postinstall shim with no binary in it - which pantry then installed as
    // the system bun, shimmed into `.bin/bun`, so every tool that shelled out to
    // it failed with ENOEXEC. `mysql.com` would have become npm's `mysql` driver
    // the same way, had the binary registry not answered first.
    //
    // So an answer that comes from npm is not an answer to this question. A
    // system package that is genuinely missing has to fail as missing.
    if (root.object.get("tarballUrl")) |t| {
        if (t == .string and std.mem.indexOf(u8, t.string, "registry.npmjs.org") != null)
            return null;
    }

    // Extract version from metadata
    const version_str = if (root.object.get("version")) |v| (if (v == .string) v.string else return error.InvalidRegistryMetadata) else return error.InvalidRegistryMetadata;

    // Check if the published version satisfies the constraint
    const is_any = std.mem.eql(u8, version_constraint, "latest") or
        std.mem.eql(u8, version_constraint, "*") or
        version_constraint.len == 0;

    if (!is_any) {
        const constraint = semver.parseConstraint(version_constraint) catch return null;
        if (!semver.satisfiesConstraint(version_str, constraint)) return null;
    }

    // Use the canonical tarball endpoint (always works via registry proxy)
    const tarball_url = try std.fmt.allocPrint(
        allocator,
        "https://registry.pantry.dev/packages/{s}/{s}/tarball",
        .{ pkg_name, version_str },
    );
    errdefer allocator.free(tarball_url);
    const version_dupe = try allocator.dupe(u8, version_str);

    return S3PackageResult{
        .tarball_url = tarball_url,
        .version = version_dupe,
    };
}

/// Verify file checksum (SHA256)
pub fn verifyChecksum(
    allocator: std.mem.Allocator,
    file_path: []const u8,
    expected_checksum: []const u8,
) !bool {
    // Read file contents
    const contents = try io_helper.readFileAlloc(allocator, file_path, 1024 * 1024 * 1024);
    defer allocator.free(contents);

    // Compute SHA256 hash
    var hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(contents, &hash, .{});

    // Convert to hex string
    const hex_buf = std.fmt.bytesToHex(hash, .lower);
    const hex = hex_buf[0..];

    // Compare with expected
    if (!std.mem.eql(u8, hex, expected_checksum)) {
        style.printChecksumMismatch(expected_checksum, hex);
        return error.ChecksumMismatch;
    }

    return true;
}

/// Download file and verify checksum
pub fn downloadFileWithChecksum(
    allocator: std.mem.Allocator,
    url: []const u8,
    dest_path: []const u8,
    expected_checksum: ?[]const u8,
) !void {
    // Download file
    try downloadFile(allocator, url, dest_path);

    // Verify checksum if provided
    if (expected_checksum) |checksum| {
        style.printChecksum(true);
        _ = try verifyChecksum(allocator, dest_path, checksum);
        style.printChecksum(false);
    }
}

/// Download a file with one deadline and a shared safe-GET retry budget.
pub fn downloadFileWithRetry(allocator: std.mem.Allocator, url: []const u8, dest_path: []const u8, options: DownloadOptions) !void {
    return io_helper.runDownloadWithRetry(downloadFileTask, .{ allocator, url, dest_path, false, @as(?InlineProgressOptions, null) }, dest_path, .{
        .max_attempts = options.max_retries,
        .initial_retry_delay_ms = options.initial_retry_delay_ms,
    });
}

test "buildPackageUrl" {
    const allocator = std.testing.allocator;

    const url = try buildPackageUrl(allocator, "bun.sh", "1.0.0", "tar.gz");
    defer allocator.free(url);

    const platform = platform_core.Platform.current();
    const arch = platform_core.Architecture.current();

    if (platform == .darwin and arch == .aarch64) {
        try std.testing.expectEqualStrings(
            "https://dist.pkgx.dev/bun.sh/darwin/aarch64/v1.0.0.tar.gz",
            url,
        );
    }
}

test "verifyChecksum" {
    const allocator = std.testing.allocator;

    // Create a test file
    const test_file = "test_checksum.txt";
    const test_content = "Hello, World!";

    {
        const file = try io_helper.cwd().createFile(io_helper.io, test_file, .{});
        defer file.close(io_helper.io);
        try io_helper.writeAllToFile(file, test_content);
    }
    defer io_helper.deleteFile(test_file) catch {};

    // Expected SHA256 of "Hello, World!"
    const expected = "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f";

    // Should pass with correct checksum
    const valid = try verifyChecksum(allocator, test_file, expected);
    try std.testing.expect(valid);

    // Should fail with incorrect checksum
    const wrong_checksum = "0000000000000000000000000000000000000000000000000000000000000000";
    const result = verifyChecksum(allocator, test_file, wrong_checksum);
    try std.testing.expectError(error.ChecksumMismatch, result);
}

test "parseVersionParts and compareParts" {
    try std.testing.expectEqual(compareParts(parseVersionParts("1.2.3"), parseVersionParts("1.2.4")), .lt);
    try std.testing.expectEqual(compareParts(parseVersionParts("2.0.0"), parseVersionParts("1.9.9")), .gt);
    try std.testing.expectEqual(compareParts(parseVersionParts("1.0.0"), parseVersionParts("1.0.0")), .eq);
}

test "isZigDevVersion" {
    try std.testing.expect(isZigDevVersion("0.16.0-dev.1484+d0ba6642b"));
    try std.testing.expect(isZigDevVersion("0.16.0-dev"));
    try std.testing.expect(isZigDevVersion("0.14.0-dev.2851+b074a1eb8"));
    try std.testing.expect(!isZigDevVersion("0.15.2"));
    try std.testing.expect(!isZigDevVersion("1.0.0"));
    try std.testing.expect(!isZigDevVersion("0.16.0"));
}

test "Zig download URL always uses the Pantry registry" {
    const allocator = std.testing.allocator;
    const url = try buildZiglangUrl(allocator, "0.17.0-dev.1422+e863bf3be");
    defer allocator.free(url);

    try std.testing.expect(std.mem.startsWith(u8, url, "https://registry.pantry.dev/binaries/ziglang.org/"));
    try std.testing.expect(std.mem.indexOf(u8, url, "ziglang.org/builds") == null);
    try std.testing.expect(std.mem.indexOf(u8, url, "ziglang.org/download") == null);
}

test "Zig fallback URL uses official archives" {
    const allocator = std.testing.allocator;
    const url = try buildZiglangFallbackUrl(allocator, "0.17.0-dev.1509_bb296ab9b");
    defer allocator.free(url);

    try std.testing.expect(std.mem.startsWith(u8, url, "https://ziglang.org/builds/zig-"));
    try std.testing.expect(std.mem.indexOf(u8, url, "0.17.0-dev.1509+bb296ab9b") != null);
}
