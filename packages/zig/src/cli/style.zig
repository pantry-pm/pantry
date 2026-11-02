//! Centralized CLI Output Styling
//!
//! Provides consistent colors, symbols, and formatting helpers for all CLI output.
//! All user-facing output should go through this module to ensure:
//! - Output goes to stdout (not stderr via std.debug.print)
//! - Consistent color and symbol usage across all commands
//! - Bun-like clean, minimal aesthetic

const std = @import("std");
const builtin = @import("builtin");
const io_helper = @import("../io_helper.zig");

// ── Colors ──────────────────────────────────────────────────────────────────

pub const green = "\x1b[32m";
pub const red = "\x1b[31m";
pub const yellow = "\x1b[33m";
pub const blue = "\x1b[34m";
pub const cyan = "\x1b[36m";
pub const dim = "\x1b[2m";
pub const bold = "\x1b[1m";
pub const italic = "\x1b[3m";
pub const dim_italic = "\x1b[2;3m";
pub const bold_cyan = "\x1b[1;36m";
pub const green_bold = "\x1b[32;1m";
pub const reset = "\x1b[0m";

// ── Symbols (Bun-style: + for added, - for removed) ────────────────────────

pub const plus = "+";
pub const minus = "-";
pub const warn = "!";
pub const arrow = ">";
pub const check = "done";
pub const info = "i";
pub const link_sym = "~";

// ── Environment Detection ───────────────────────────────────────────────────

/// Detect if running in CI (no interactive terminal). Cached after first check.
var ci_detected: enum { unknown, yes, no } = .unknown;
pub fn isCI() bool {
    if (ci_detected != .unknown) return ci_detected == .yes;
    // Check common CI environment variables
    const ci_vars = [_][]const u8{ "CI", "GITHUB_ACTIONS", "NO_COLOR", "BUILDKITE", "CIRCLECI", "GITLAB_CI" };
    for (ci_vars) |v| {
        if (io_helper.getEnvVarOwned(std.heap.page_allocator, v) catch null) |val| {
            std.heap.page_allocator.free(val);
            ci_detected = .yes;
            return true;
        }
    }
    ci_detected = .no;
    return false;
}

// ── Quiet Mode ────────────────────────────────────────────────────────────

/// Global quiet flag. When set, `print()` — and every helper built on it
/// (progress, per-package lines, summaries, headers) — is suppressed. Errors
/// and failures bypass it via `printForced` so breakage is never hidden.
/// Set by the install command from `--quiet` / `InstallOptions.quiet`.
/// Process-lifetime: the CLI runs one command then exits, so there is no reset.
var quiet_mode: bool = false;

pub fn setQuiet(value: bool) void {
    quiet_mode = value;
}

pub fn isQuiet() bool {
    return quiet_mode;
}

/// When true, `emit` writes to stderr instead of stdout. Commands whose stdout
/// is consumed by `eval "$(...)"` (notably `env`) enable this so all
/// human-facing output — progress, install/download lines, errors — goes to
/// stderr and never corrupts the shell code emitted on stdout.
var diagnostics_to_stderr: bool = false;

pub fn setDiagnosticsToStderr(value: bool) void {
    diagnostics_to_stderr = value;
}

/// Whether diagnostics are currently routed to stderr. Lets spawn sites
/// (e.g. the JS package-manager delegate) redirect CHILD stdout too — the
/// flag alone only covers our own `print` calls, not an inherited fd.
pub fn isDiagnosticsToStderr() bool {
    return diagnostics_to_stderr;
}

// ── Color Detection ──────────────────────────────────────────────────────

/// Whether ANSI escape sequences (color, cursor moves) should be emitted.
/// Disabled when `NO_COLOR` is set (https://no-color.org) or when stdout is not
/// a terminal (piped/redirected), unless `FORCE_COLOR` overrides. When off,
/// `emit` strips escape sequences so redirected output / `pantry … > file` is
/// plain text. Cached after the first check.
var color_state: enum { unknown, on, off } = .unknown;

pub fn colorsEnabled() bool {
    if (color_state != .unknown) return color_state == .on;
    const a = std.heap.page_allocator;
    // NO_COLOR (any value) wins.
    if (io_helper.getEnvVarOwned(a, "NO_COLOR")) |v| {
        a.free(v);
        color_state = .off;
        return false;
    } else |_| {}
    // FORCE_COLOR keeps color even when piped (useful for CI logs that render it).
    if (io_helper.getEnvVarOwned(a, "FORCE_COLOR")) |v| {
        a.free(v);
        color_state = .on;
        return true;
    } else |_| {}
    // Otherwise: colorize only on a real terminal.
    const tty = io_helper.File.stdout().isTty(io_helper.io) catch false;
    color_state = if (tty) .on else .off;
    return tty;
}

/// Strip ANSI CSI escape sequences (ESC '[' … final-byte) in place. The output
/// is never longer than the input, so we filter within the same buffer.
fn stripAnsi(s: []u8) []u8 {
    var w: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        if (s[i] == 0x1b and i + 1 < s.len and s[i + 1] == '[') {
            i += 2;
            // CSI parameter/intermediate bytes: 0x20–0x3F
            while (i < s.len and s[i] >= 0x20 and s[i] <= 0x3f) : (i += 1) {}
            // Final byte: 0x40–0x7E (consume it too)
            if (i < s.len and s[i] >= 0x40 and s[i] <= 0x7e) i += 1;
        } else {
            s[w] = s[i];
            w += 1;
            i += 1;
        }
    }
    return s[0..w];
}

// ── Core Output ─────────────────────────────────────────────────────────────

/// Write a formatted message straight to stdout, ignoring quiet mode. Backs
/// both `print` (gated) and `printForced` (always). Strips ANSI when color is
/// disabled. Thread-safe via write().
fn emit(comptime fmt: []const u8, args: anytype) void {
    if (builtin.is_test) {
        return;
    }
    var buf: [65536]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, fmt, args) catch {
        // Fallback for messages that exceed buffer
        std.debug.print(fmt, args);
        return;
    };
    // On the interactive TTY path colorsEnabled() is true (cached) and `msg`
    // is written as-is — no scan. Stripping only runs when output is redirected.
    const out = if (colorsEnabled()) msg else stripAnsi(msg);
    const target = if (diagnostics_to_stderr) io_helper.File.stderr() else io_helper.File.stdout();
    io_helper.writeAllToFile(target, out) catch {
        // Last resort: try stderr
        std.debug.print(fmt, args);
    };
}

/// Print to stdout (user-facing output). Suppressed under quiet mode.
pub fn print(comptime fmt: []const u8, args: anytype) void {
    if (quiet_mode) return;
    emit(fmt, args);
}

/// Print to stdout even under quiet mode — for output that must always surface
/// (errors, failures). Use sparingly; most output should go through `print`.
pub fn printForced(comptime fmt: []const u8, args: anytype) void {
    emit(fmt, args);
}

/// Clear the current line (carriage return + erase to end). No-op in CI.
pub fn clearLine() void {
    if (isCI()) return;
    print("\r\x1b[K", .{});
}

/// Move cursor up N lines
pub fn moveUp(n: usize) void {
    if (n > 0) print("\x1b[{d}A", .{n});
}

/// Move cursor down N lines
pub fn moveDown(n: usize) void {
    if (n > 0) print("\x1b[{d}B", .{n});
}

// ── Package Formatting ──────────────────────────────────────────────────────

/// Print a successfully installed package: + bold(name)@dim(version)
pub fn printInstalled(name: []const u8, version: []const u8) void {
    print("{s}{s}{s} {s}{s}{s}{s}@{s}{s}\n", .{
        green, plus,    reset,
        bold,  name,    reset,
        dim,   version, reset,
    });
}

/// Print a successfully linked package: + bold(name)@dim(version) dim((linked))
pub fn printLinked(name: []const u8, version: []const u8) void {
    print("{s}{s}{s} {s}{s}{s}{s}@{s} {s}(linked){s}\n", .{
        green, plus,    reset,
        bold,  name,    reset,
        dim,   version, dim,
        reset,
    });
}

/// Print an auto-linked package: + bold(name) dim((auto-linked from path))
pub fn printAutoLinked(name: []const u8, path: []const u8) void {
    print("{s}{s}{s} {s}{s}{s} {s}(auto-linked from {s}){s}\n", .{
        green, plus, reset,
        bold,  name, reset,
        dim,   path, reset,
    });
}

/// Print a failed package: - bold(name)@dim(version) dim((reason))
/// Forced: failures must surface even under quiet mode.
pub fn printFailed(name: []const u8, version: []const u8, reason: ?[]const u8) void {
    recordFailure(name, version, reason);
    printForced("{s}{s}{s} {s}{s}{s}{s}@{s}", .{
        red,  minus,   reset,
        bold, name,    reset,
        dim,  version,
    });
    if (reason) |msg| {
        printForced(" {s}({s}){s}\n", .{ dim, msg, reset });
    } else {
        printForced("\n", .{});
    }
}

/// Print a warning for a package: ! bold(name)@dim(version) dim((reason))
pub fn printWarning(name: []const u8, version: []const u8, reason: []const u8) void {
    print("{s}{s}{s} {s}{s}{s}{s}@{s} {s}({s}){s}\n", .{
        yellow, warn,    reset,
        bold,   name,    reset,
        dim,    version, dim,
        reason, reset,
    });
}

// ── Headers & Summaries ─────────────────────────────────────────────────────

/// Format an elapsed duration human-friendly into `buf`: "2.9s" past a second,
/// "850ms" below it — the way bun/pnpm/yarn report timing. Never fails loudly.
fn formatDuration(buf: []u8, ms: f64) []const u8 {
    if (ms >= 1000.0) {
        return std.fmt.bufPrint(buf, "{d:.1}s", .{ms / 1000.0}) catch "?";
    }
    return std.fmt.bufPrint(buf, "{d:.0}ms", .{ms}) catch "?";
}

/// Print the command header: "pantry install v0.x.x (hash)"
pub fn printHeader(command: []const u8, version: []const u8, hash: []const u8) void {
    print("\n{s}pantry {s}{s} {s}v{s} ({s}){s}\n\n", .{
        bold,  command, reset,
        dim,   version, hash,
        reset,
    });
}

/// Print the "all up to date" summary (bun-style): "✓ N packages up to date (120ms)"
pub fn printUpToDate(pkg_count: usize, workspace_count: usize, elapsed_ms: f64) void {
    const pkg_label = if (pkg_count == 1) "package" else "packages";
    var buf: [32]u8 = undefined;
    const took = formatDuration(&buf, elapsed_ms);
    if (workspace_count > 0) {
        const ws_label = if (workspace_count == 1) "workspace member" else "workspace members";
        print("\n{s}✓{s} {s}{d}{s} {s} + {s}{d}{s} {s} up to date {s}({s}){s}\n", .{
            green, reset,           bold,  pkg_count, reset, pkg_label,
            bold,  workspace_count, reset, ws_label,  dim,   took,
            reset,
        });
    } else {
        print("\n{s}✓{s} {s}{d}{s} {s} up to date {s}({s}){s}\n", .{
            green, reset, bold,  pkg_count, reset, pkg_label,
            dim,   took,  reset,
        });
    }
}

/// Print the install summary line (bun-style): "✓ N packages installed in 2.9s"
pub fn printSummary(success_count: usize, total_count: usize, elapsed_ms: f64) void {
    const label = if (success_count == 1) "package" else "packages";
    var buf: [32]u8 = undefined;
    const took = formatDuration(&buf, elapsed_ms);
    if (success_count == total_count) {
        print("\n{s}✓{s} {s}{d}{s} {s} installed {s}in {s}{s}\n", .{
            green, reset, bold, success_count, reset, label, dim, took, reset,
        });
    } else {
        print("\n{s}{d}{s}/{d} {s} installed {s}in {s}{s}\n", .{
            yellow, success_count, reset, total_count, label, dim, took, reset,
        });
    }
}

/// Print checked summary (no changes): "✓ N packages up to date (120ms)"
pub fn printCheckedSummary(success_count: usize, total_count: usize, elapsed_ms: f64) void {
    _ = success_count;
    const label = if (total_count == 1) "package" else "packages";
    var buf: [32]u8 = undefined;
    const took = formatDuration(&buf, elapsed_ms);
    print("\n{s}✓{s} {s}{d}{s} {s} up to date {s}({s}){s}\n", .{
        green, reset, bold, total_count, reset, label, dim, took, reset,
    });
}

/// Print failure count. Forced: must surface even under quiet mode. A caller
/// that did not print the failure report before its summary gets it here, so
/// the count never appears without the packages it counts.
pub fn printFailureCount(count: usize) void {
    printFailureReport();
    printForced("\n{s}{d} package(s) failed to install{s}\n", .{ red, count, reset });
}

// ── Failure report ──────────────────────────────────────────────────────────
//
// Every `printFailed` line is also recorded here, and the install summary
// repeats them as one block on stderr: name, version, reason, and whether the
// failure is transient. Inline failure lines scroll away among a long install
// (CI job 7047 printed `87/88 packages installed` and `1 package(s) failed to
// install` with the one failed package buried 90 lines up, glued to the end of
// its progress line), so the summary has to name them itself.

const max_failure_records = 64;

const FailureRecord = struct {
    name: []const u8,
    version: []const u8,
    reason: []const u8,
    transient: bool,
};

var failure_lock: io_helper.Mutex = .{};
var failure_bytes: [16 * 1024]u8 = undefined;
var failure_bytes_used: usize = 0;
var failure_records: [max_failure_records]FailureRecord = undefined;
var failure_records_len: usize = 0;
var failure_records_dropped: usize = 0;
var failure_report_printed: bool = false;

fn keepFailureText(text: []const u8) []const u8 {
    const room = failure_bytes.len - failure_bytes_used;
    const kept = text[0..@min(text.len, room)];
    @memcpy(failure_bytes[failure_bytes_used..][0..kept.len], kept);
    defer failure_bytes_used += kept.len;
    return failure_bytes[failure_bytes_used..][0..kept.len];
}

/// Record one failed package for the summary report. Copies its arguments.
pub fn recordFailure(name: []const u8, version: []const u8, reason: ?[]const u8) void {
    failure_lock.lock();
    defer failure_lock.unlock();
    if (failure_records_len == max_failure_records) {
        failure_records_dropped += 1;
        return;
    }
    const why = reason orelse "no error detail was reported";
    failure_records[failure_records_len] = .{
        .name = keepFailureText(name),
        .version = keepFailureText(version),
        .reason = keepFailureText(why),
        .transient = isTransientReason(why),
    };
    failure_records_len += 1;
    failure_report_printed = false;
}

/// Forget recorded failures (tests, and commands that report per phase).
pub fn resetFailures() void {
    failure_lock.lock();
    defer failure_lock.unlock();
    failure_bytes_used = 0;
    failure_records_len = 0;
    failure_records_dropped = 0;
    failure_report_printed = false;
}

/// The failure report as plain text: no colour and no carriage returns, one
/// package per line, so it survives a CI log intact. `annotate` adds a
/// workflow-command `::error` line per package, which GitHub Actions and
/// ReviewOS lift into the run summary.
pub fn formatFailureReport(buffer: []u8, annotate: bool) []const u8 {
    failure_lock.lock();
    defer failure_lock.unlock();
    var writer: std.Io.Writer = .fixed(buffer);
    writeFailureReport(&writer, annotate) catch {};
    return writer.buffered();
}

fn writeFailureReport(writer: *std.Io.Writer, annotate: bool) std.Io.Writer.Error!void {
    const total = failure_records_len + failure_records_dropped;
    if (total == 0) return;
    try writer.print("\nerror: {d} {s} failed to install:\n", .{ total, if (total == 1) "package" else "packages" });
    for (failure_records[0..failure_records_len]) |record| {
        try writer.print("  {s}", .{record.name});
        if (record.version.len > 0) try writer.print("@{s}", .{record.version});
        try writer.print(": {s}", .{record.reason});
        if (record.transient) try writer.writeAll(" [transient: network, timeout or registry outage; a rerun may pass]");
        try writer.writeAll("\n");
    }
    if (failure_records_dropped > 0) try writer.print("  ...and {d} more\n", .{failure_records_dropped});
    if (!annotate) return;
    for (failure_records[0..failure_records_len]) |record| {
        try writer.writeAll("::error title=pantry install failed::");
        try writeWorkflowData(writer, record.name);
        if (record.version.len > 0) {
            try writer.writeAll("@");
            try writeWorkflowData(writer, record.version);
        }
        try writer.writeAll(": ");
        try writeWorkflowData(writer, record.reason);
        if (record.transient) try writer.writeAll(" (transient)");
        try writer.writeAll("\n");
    }
}

/// Workflow-command message data escapes `%`, CR and LF.
fn writeWorkflowData(writer: *std.Io.Writer, text: []const u8) std.Io.Writer.Error!void {
    for (text) |c| switch (c) {
        '%' => try writer.writeAll("%25"),
        '\r' => try writer.writeAll("%0D"),
        '\n' => try writer.writeAll("%0A"),
        else => try writer.writeByte(c),
    };
}

/// Print the recorded failures to stderr, once, ahead of the summary. Forced:
/// it surfaces under `--quiet` too.
pub fn printFailureReport() void {
    if (builtin.is_test) return;
    if (failure_report_printed) return;
    var buffer: [24 * 1024]u8 = undefined;
    const annotate = if (io_helper.getEnvVarOwned(std.heap.page_allocator, "GITHUB_ACTIONS") catch null) |value| blk: {
        defer std.heap.page_allocator.free(value);
        break :blk std.mem.eql(u8, value, "true");
    } else false;
    const report = formatFailureReport(&buffer, annotate);
    failure_report_printed = true;
    if (report.len == 0) return;
    // The report opens with a newline, which also ends a progress line
    // (`  > name@1.0...`) still open on a terminal shared with stdout.
    io_helper.writeAllToFile(io_helper.File.stderr(), report) catch {};
}

/// Whether a failure reason names a cause a rerun can clear: the network, a
/// deadline, or a registry gateway answer. Absence, authentication, checksum
/// and extraction failures are not transient.
pub fn isTransientReason(reason: []const u8) bool {
    const markers = [_][]const u8{
        "timed out",          "timeout",           "network",     "connection reset",
        "connection refused", "connection closed", "dns failure", "registry unavailable",
        "rate limited",       "http 429",          "http 502",    "http 503",
        "http 504",           "temporarily",
    };
    var lower_buffer: [512]u8 = undefined;
    const lower = std.ascii.lowerString(&lower_buffer, reason[0..@min(reason.len, lower_buffer.len)]);
    for (markers) |marker| {
        if (std.mem.indexOf(u8, lower, marker) != null) return true;
    }
    return false;
}

/// Whether an install error is worth one more attempt (see `isTransientReason`).
pub fn isTransientInstallError(err: anyerror) bool {
    return switch (err) {
        error.Timeout,
        error.ConnectionTimedOut,
        error.ConnectionResetByPeer,
        error.ConnectionRefused,
        error.NetworkUnreachable,
        error.HostUnreachable,
        error.NetworkError,
        error.HttpRequestFailed,
        error.HttpConnectionClosing,
        error.TemporaryNameServerFailure,
        error.NameServerFailure,
        error.RegistryUnavailable,
        error.RegistryRateLimited,
        error.UnexpectedEndOfStream,
        error.EndOfStream,
        => true,
        else => false,
    };
}

test "failure report names every failed package, its version and reason" {
    resetFailures();
    defer resetFailures();
    recordFailure("ffmpeg.org", "9.0.2", "timed out after registry HTTP 503 (Retry-After 60s)");
    recordFailure("example.com/tool", "1.0.0", "checksum mismatch");
    var buffer: [4096]u8 = undefined;
    const report = formatFailureReport(&buffer, false);
    try std.testing.expectEqualStrings(
        "\nerror: 2 packages failed to install:\n" ++
            "  ffmpeg.org@9.0.2: timed out after registry HTTP 503 (Retry-After 60s) [transient: network, timeout or registry outage; a rerun may pass]\n" ++
            "  example.com/tool@1.0.0: checksum mismatch\n",
        report,
    );
    try std.testing.expect(std.mem.indexOfScalar(u8, report, 0x1b) == null);
    try std.testing.expect(std.mem.indexOfScalar(u8, report, '\r') == null);
}

test "failure report annotations escape workflow-command data" {
    resetFailures();
    defer resetFailures();
    recordFailure("ffmpeg.org", "9.0.2", "100% stalled\nthen timed out");
    var buffer: [4096]u8 = undefined;
    const report = formatFailureReport(&buffer, true);
    try std.testing.expect(std.mem.indexOf(u8, report, "::error title=pantry install failed::ffmpeg.org@9.0.2: 100%25 stalled%0Athen timed out (transient)\n") != null);
}

test "failure report keeps a count past its record limit and nothing when clean" {
    resetFailures();
    defer resetFailures();
    var buffer: [16 * 1024]u8 = undefined;
    try std.testing.expectEqualStrings("", formatFailureReport(&buffer, false));
    for (0..max_failure_records + 3) |_| recordFailure("a.org", "1.0.0", null);
    const report = formatFailureReport(&buffer, false);
    try std.testing.expect(std.mem.startsWith(u8, report, "\nerror: 67 packages failed to install:\n"));
    try std.testing.expect(std.mem.endsWith(u8, report, "  ...and 3 more\n"));
    try std.testing.expect(std.mem.indexOf(u8, report, "a.org@1.0.0: no error detail was reported\n") != null);
}

test "transient failures are told apart from permanent ones" {
    try std.testing.expect(isTransientInstallError(error.Timeout));
    try std.testing.expect(isTransientInstallError(error.RegistryUnavailable));
    try std.testing.expect(!isTransientInstallError(error.PackageNotFound));
    try std.testing.expect(!isTransientInstallError(error.ChecksumMismatch));
    try std.testing.expect(isTransientReason("Registry GET HTTP 503"));
    try std.testing.expect(isTransientReason(friendlyErrorName(error.Timeout)));
    try std.testing.expect(!isTransientReason(friendlyErrorName(error.ChecksumMismatch)));
    try std.testing.expect(!isTransientReason("not found in pantry or npm registry"));
}

// ── Progress ────────────────────────────────────────────────────────────────

/// Spinner frames (simple rotating chars)
const spinner_frames = [_][]const u8{ "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" };

/// Print a single-line spinner with package name and progress counter.
/// Overwrites the current line each call. Suppressed in CI (causes log noise).
pub fn printProgress(current: usize, total: usize, pkg_name: []const u8, frame: usize) void {
    if (isCI()) return;
    const spinner = spinner_frames[frame % spinner_frames.len];
    print("\r\x1b[K{s}{s}{s} {s}{s}{s} {s}[{d}/{d}]{s}", .{
        cyan,  spinner,  reset,
        bold,  pkg_name, reset,
        dim,   current,  total,
        reset,
    });
}

/// Clear the progress line and print a final newline
pub fn clearProgress() void {
    clearLine();
}

/// Live single-line progress for the parallel download/extract phase:
/// `⠹ installing 4/9 packages`, redrawn in place each frame. TTY-only — skipped
/// in CI, when output is redirected (no colors), or under quiet — so logs and
/// pipes never collect carriage-return spam. This is what keeps a multi-second
/// install visibly alive instead of looking hung.
pub fn printPipelineProgress(done: usize, total: usize, frame: usize) void {
    if (isCI() or !colorsEnabled() or quiet_mode) return;
    const spinner = spinner_frames[frame % spinner_frames.len];
    const label = if (total == 1) "package" else "packages";
    print("\r\x1b[K{s}{s}{s} {s}installing{s} {s}{d}{s}{s}/{d} {s}{s}", .{
        cyan,  spinner, reset,
        dim,   reset,   bold,
        done,  reset,   dim,
        total, label,   reset,
    });
}

// ── Indicators ──────────────────────────────────────────────────────────────

/// Lockfile save is fast and uninteresting; bun/pnpm don't announce it, and the
/// old transient "Saving lockfile..." line collided with the summary when output
/// was piped (no TTY to clear it). Kept as no-ops so call sites stay unchanged.
pub fn printLockfileSaving() void {}

pub fn printLockfileSaved() void {}

/// Print installing message. If `resuming_count > 0`, annotates the line to
/// indicate this is a continuation of a prior interrupted install.
pub fn printInstalling(count: usize) void {
    printInstallingEx(count, 0);
}

pub fn printInstallingEx(count: usize, resuming_count: usize) void {
    // bun-style: no upfront "Installing N packages" line — the header, the live
    // spinner during downloads, and the final summary already convey scope. The
    // resuming case still gets a one-line note so an interrupted install reads
    // clearly.
    _ = count;
    if (resuming_count > 0) {
        print("{s}resuming — {d} already completed{s}\n", .{ dim, resuming_count, reset });
    }
}

/// Map common Zig error names to user-friendly messages. Falls back to a
/// lowercased version of the error name for unknown errors.
pub fn friendlyErrorName(err: anyerror) []const u8 {
    return switch (err) {
        error.DownloadFailed => "download failed",
        error.HttpRequestFailed => "network error",
        error.NetworkError => "network error",
        error.InvalidUrl => "invalid URL",
        error.PackageNotFound => "not found in registry",
        error.PaymentRequired => "paywalled (HTTP 402)",
        error.OutOfMemory => "out of memory",
        error.FileNotFound => "file not found",
        error.AccessDenied => "access denied",
        error.ConnectionRefused => "connection refused",
        error.ConnectionTimedOut => "connection timed out",
        error.TlsInitializationFailed => "TLS error",
        error.Timeout => "timed out",
        error.ConnectionResetByPeer => "connection reset",
        error.NetworkUnreachable, error.HostUnreachable => "network unreachable",
        error.TemporaryNameServerFailure, error.NameServerFailure => "DNS failure",
        error.UnknownHostName => "unknown host",
        error.RegistryUnavailable => "registry unavailable",
        error.RegistryRateLimited => "registry rate limited (HTTP 429)",
        error.RegistryAuthenticationRequired => "registry authentication required (HTTP 401/403)",
        error.RegistryArtifactNotFound => "artifact missing from registry (HTTP 404)",
        error.InvalidRegistryMetadata => "invalid registry metadata",
        error.ChecksumMismatch => "checksum mismatch",
        error.IntegrityMismatch => "integrity mismatch",
        error.ExtractionFailed => "extract failed",
        else => @errorName(err),
    };
}

/// Print skip message
pub fn printSkipping(skipped: usize, remaining: usize) void {
    print("{s}  > {d} package(s) already up to date, installing {d} remaining...{s}\n", .{
        dim, skipped, remaining, reset,
    });
}

/// Print offline mode message
pub fn printOffline() void {
    print("{s}Offline mode enabled - using cache only{s}\n", .{ dim, reset });
}

/// Print a generic warning line
pub fn printWarn(comptime fmt: []const u8, args: anytype) void {
    print("{s}{s}{s} ", .{ yellow, warn, reset });
    print(fmt, args);
}

/// Print a generic error line. Forced: errors must surface even under quiet mode.
pub fn printError(comptime fmt: []const u8, args: anytype) void {
    printForced("{s}error{s}: ", .{ red, reset });
    printForced(fmt, args);
}

/// Say that an install moved a pantry.lock pin. A plain install keeps a pin
/// that still satisfies its range, so a moved one has a cause worth naming -
/// most often bun.lock, whose in-range pin pantry follows so pantry/ and
/// node_modules/ hold one tree (stacksjs/stacks#2848). Unannounced, the move
/// read as pantry re-resolving to the newest release.
pub fn printLockPinMoved(name: []const u8, from: []const u8, to: []const u8, via_bun_lock: bool) void {
    print("{s}pantry.lock: {s} {s} -> {s}{s}{s}\n", .{
        dim,
        name,
        from,
        to,
        if (via_bun_lock) " (pinned by bun.lock)" else "",
        reset,
    });
}

/// Print a generic info line (dim)
pub fn printInfo(comptime fmt: []const u8, args: anytype) void {
    print("{s}", .{dim});
    print(fmt, args);
    print("{s}", .{reset});
}

// ── Workspace ───────────────────────────────────────────────────────────────

/// Print workspace header
pub fn printWorkspaceHeader(name: []const u8) void {
    print("{s}Workspace:{s} {s}\n", .{ blue, reset, name });
}

/// Print workspace member count
pub fn printWorkspaceMembers(count: usize) void {
    print("{s}   Found {d} workspace member(s)\n\n", .{ dim, count });
}

/// Print workspace member name
pub fn printWorkspaceMember(name: []const u8) void {
    print("{s}  {s}{s}\n", .{ dim, name, reset });
}

/// Print workspace member dependency count
pub fn printWorkspaceMemberDeps(count: usize) void {
    print("{s}   > {d} dependencies\n", .{ dim, count });
}

/// Print workspace member with no dependencies
pub fn printWorkspaceMemberNoDeps() void {
    print("{s}   > No dependencies\n", .{dim});
}

/// Print workspace linked count
pub fn printWorkspaceLinked(count: usize) void {
    print("{s}Linked {d} workspace package(s){s}\n", .{ blue, count, reset });
}

/// Print workspace complete summary with elapsed time
pub fn printWorkspaceComplete(success: usize, failed: usize, elapsed_ms: u64) void {
    printWorkspaceCompleteEx(success, 0, failed, elapsed_ms);
}

/// Print workspace complete summary with cached breakdown
pub fn printWorkspaceCompleteEx(success: usize, cached: usize, failed: usize, elapsed_ms: u64) void {
    print("\n{s}{s}{s} Workspace setup complete! Installed {d} package(s)", .{
        green, check, reset, success,
    });
    if (cached > 0) {
        print(" {s}({d} cached){s}", .{ dim, cached, reset });
    }
    if (failed > 0) {
        print(", {s}{d} failed{s}", .{ red, failed, reset });
    }
    print(" {s}({d}ms){s}\n", .{ dim, elapsed_ms, reset });
}

// ── Global ──────────────────────────────────────────────────────────────────

/// Print global install result (success)
pub fn printGlobalInstalled(name: []const u8, version: []const u8, from_cache: bool, time_ms: u64) void {
    print("  {s}{s}{s} {s}{s}{s}{s}@{s}", .{
        green, plus,    reset,
        bold,  name,    reset,
        dim,   version,
    });
    print(" {s}({s}, {d}ms){s}\n", .{
        dim,
        if (from_cache) "cached" else "installed",
        time_ms,
        reset,
    });
}

/// Print global install complete
pub fn printGlobalComplete(dir: []const u8) void {
    print("\n{s}{s}{s} Packages installed to: {s}\n", .{ green, check, reset, dir });
}

/// The global bin dir is missing from PATH, so what was just installed
/// cannot be run yet. Say so, and give the two ways to fix it.
pub fn printBinNotOnPath(bin_dir: []const u8) void {
    print("\n{s}{s}{s} {s} is not on your PATH, so these commands won't be found yet.\n", .{ yellow, warn, reset, bin_dir });
    print("  Run {s}pantry shell:integrate{s}, or add it yourself:\n", .{ bold, reset });
    print("    {s}export PATH=\"{s}:$PATH\"{s}\n", .{ dim, bin_dir, reset });
}

// ── Download Progress ───────────────────────────────────────────────────────

/// Print download progress (standard mode - overwrites same line)
pub fn printDownloadProgress(current_str: []const u8, total_str: ?[]const u8, speed_str: ?[]const u8, first_line: bool) void {
    if (first_line) {
        print("\n", .{});
    }
    print("\r{s}  ", .{dim_italic});
    print("{s}", .{current_str});
    if (total_str) |ts| {
        print(" / {s}", .{ts});
    }
    if (speed_str) |ss| {
        print(" ({s})", .{ss});
    }
    print("{s}", .{reset});
}

/// Print invalid URL error
pub fn printInvalidUrl(url: []const u8) void {
    print("{s}{s}{s} Invalid URL: {s}\n", .{ red, minus, reset, url });
}

/// Print checksum verification
pub fn printChecksum(verifying: bool) void {
    if (verifying) {
        print("\n  Verifying checksum...", .{});
    } else {
        print(" {s}{s}{s}\n", .{ green, check, reset });
    }
}

/// Print checksum mismatch
pub fn printChecksumMismatch(expected: []const u8, got: []const u8) void {
    print("  {s}{s}{s} Checksum mismatch:\n", .{ red, minus, reset });
    print("    Expected: {s}\n", .{expected});
    print("    Got:      {s}\n", .{got});
}

/// Print retry message
pub fn printRetry(attempt: u32, max: u32, delay_ms: u64) void {
    print("  Retry {d}/{d} after {d}ms...\n", .{ attempt, max, delay_ms });
}

/// Print download failure
pub fn printDownloadFailed(attempts: u32, err: anyerror) void {
    print("\n  {s}{s}{s} Download failed after {d} attempts: {}\n", .{ red, minus, reset, attempts, err });
}

/// Print download attempt failure
pub fn printDownloadAttemptFailed(attempt: u32, err: anyerror) void {
    print("\n  {s}{s}{s} Download failed (attempt {d}): {}\n", .{ yellow, warn, reset, attempt, err });
}
