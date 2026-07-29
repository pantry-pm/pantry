const std = @import("std");
const io_helper = @import("../../io_helper.zig");
const style = @import("../style.zig");
const common = @import("common.zig");
const CommandResult = common.CommandResult;

pub const PublishBinaryOptions = struct {
    domain: []const u8,
    version: []const u8,
    binary_path: []const u8,
    platform: ?[]const u8 = null,
    dry_run: bool = false,
};

fn commandFailed(result: io_helper.ChildRunResult) bool {
    return switch (result.term) {
        .exited => |code| code != 0,
        else => true,
    };
}

fn safeCommandError(allocator: std.mem.Allocator, prefix: []const u8, stderr: []const u8) !CommandResult {
    const safe_len = @min(stderr.len, 500);
    const msg = try std.fmt.allocPrint(allocator, "{s}: {s}", .{ prefix, stderr[0..safe_len] });
    return CommandResult.err(allocator, msg);
}

fn jsonString(root: std.json.Value, key: []const u8) ?[]const u8 {
    if (root != .object) return null;
    const value = root.object.get(key) orelse return null;
    return if (value == .string) value.string else null;
}

fn jsonBool(root: std.json.Value, key: []const u8) ?bool {
    if (root != .object) return null;
    const value = root.object.get(key) orelse return null;
    return if (value == .bool) value.bool else null;
}

fn isSafeIdentifier(value: []const u8, allow_slash: bool) bool {
    if (value.len == 0) return false;
    for (value) |c| {
        if (std.ascii.isAlphanumeric(c) or c == '.' or c == '_' or c == '-' or c == '+' or (allow_slash and c == '/'))
            continue;
        return false;
    }
    return true;
}

/// Publish a native binary through the registry's scan-before-promote API.
///
/// The CLI can upload only to a short-lived untrusted staging key. The registry
/// scans those exact bytes and owns the only path that promotes them into the
/// installable binaries/ namespace.
pub fn publishBinaryCommand(allocator: std.mem.Allocator, args: []const []const u8, options: PublishBinaryOptions) !CommandResult {
    _ = args;

    const platform = options.platform orelse comptime blk: {
        const os_str = switch (@import("builtin").os.tag) {
            .macos => "darwin",
            .linux => "linux",
            .windows => "windows",
            else => "linux",
        };
        const arch_str = switch (@import("builtin").cpu.arch) {
            .aarch64 => "arm64",
            .x86_64 => "x86-64",
            else => "x86-64",
        };
        break :blk os_str ++ "-" ++ arch_str;
    };

    if (!isSafeIdentifier(options.domain, true) or std.mem.indexOf(u8, options.domain, "..") != null)
        return CommandResult.err(allocator, "Invalid binary package domain");
    if (!isSafeIdentifier(options.version, false))
        return CommandResult.err(allocator, "Invalid binary package version");
    if (!isSafeIdentifier(platform, false))
        return CommandResult.err(allocator, "Invalid binary platform");

    var domain_slug_buf: [256]u8 = undefined;
    var slug_len: usize = 0;
    for (options.domain) |c| {
        if (slug_len >= domain_slug_buf.len) break;
        domain_slug_buf[slug_len] = if (c == '/' or c == '@') '-' else c;
        slug_len += 1;
    }
    const domain_slug = domain_slug_buf[0..slug_len];

    const registry = io_helper.getenv("PANTRY_REGISTRY_URL") orelse "https://registry.pantry.dev";
    const token = io_helper.getenv("PANTRY_REGISTRY_TOKEN") orelse io_helper.getenv("PANTRY_TOKEN") orelse "";

    style.print("Publishing native binary through Pantry registry\n", .{});
    style.print("  Domain:   {s}\n", .{options.domain});
    style.print("  Version:  {s}\n", .{options.version});
    style.print("  Platform: {s}\n", .{platform});
    style.print("  Binary:   {s}\n", .{options.binary_path});
    style.print("  Registry: {s}\n\n", .{registry});

    if (options.dry_run) {
        style.print("[dry-run] Would stage, scan, and promote binaries/{s}/{s}/{s}/{s}-{s}.tar.gz\n", .{
            options.domain, options.version, platform, domain_slug, options.version,
        });
        return .{ .exit_code = 0 };
    }
    if (token.len == 0)
        return CommandResult.err(allocator, "PANTRY_REGISTRY_TOKEN or PANTRY_TOKEN is required");

    io_helper.accessAbsolute(options.binary_path, .{}) catch {
        const msg = try std.fmt.allocPrint(allocator, "Error: Binary not found: {s}", .{options.binary_path});
        return CommandResult.err(allocator, msg);
    };

    const tarball_name = try std.fmt.allocPrint(allocator, "{s}-{s}.tar.gz", .{ domain_slug, options.version });
    defer allocator.free(tarball_name);
    const tarball_path = try std.fs.path.join(allocator, &.{ io_helper.getTempDir(), tarball_name });
    defer allocator.free(tarball_path);
    defer io_helper.deleteFile(tarball_path) catch {};

    style.print("  Creating tarball...\n", .{});
    const tar_result = try io_helper.childRun(allocator, &.{
        "tar", "-czf", tarball_path, "-C", std.fs.path.dirname(options.binary_path) orelse ".", std.fs.path.basename(options.binary_path),
    });
    defer allocator.free(tar_result.stdout);
    defer allocator.free(tar_result.stderr);
    if (commandFailed(tar_result))
        return safeCommandError(allocator, "Failed to create tarball", tar_result.stderr);

    const stat = io_helper.statFile(tarball_path) catch
        return CommandResult.err(allocator, "Failed to stat generated tarball");
    const hash_result = try io_helper.childRun(allocator, &.{ "shasum", "-a", "256", tarball_path });
    defer allocator.free(hash_result.stdout);
    defer allocator.free(hash_result.stderr);
    if (commandFailed(hash_result) or hash_result.stdout.len < 64)
        return safeCommandError(allocator, "Failed to hash tarball", hash_result.stderr);
    const sha256 = hash_result.stdout[0..64];

    const auth_header = try std.fmt.allocPrint(allocator, "Authorization: Bearer {s}", .{token});
    defer allocator.free(auth_header);
    const initiate_url = try std.fmt.allocPrint(allocator, "{s}/api/v1/binaries/uploads", .{std.mem.trimEnd(u8, registry, "/")});
    defer allocator.free(initiate_url);
    const initiate_json = try std.fmt.allocPrint(
        allocator,
        "{{\"domain\":\"{s}\",\"version\":\"{s}\",\"platforms\":[\"{s}\"],\"filename\":\"{s}\",\"size\":{d},\"sha256\":\"{s}\"}}",
        .{ options.domain, options.version, platform, tarball_name, stat.size, sha256 },
    );
    defer allocator.free(initiate_json);

    style.print("  Requesting scan staging upload...\n", .{});
    const initiate = try io_helper.childRun(allocator, &.{
        "curl",          "-fsS",        "-X",         "POST", "-H", auth_header, "-H", "Content-Type: application/json",
        "--data-binary", initiate_json, initiate_url,
    });
    defer allocator.free(initiate.stdout);
    defer allocator.free(initiate.stderr);
    if (commandFailed(initiate))
        return safeCommandError(allocator, "Registry rejected binary staging request", initiate.stderr);

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, initiate.stdout, .{}) catch
        return CommandResult.err(allocator, "Registry returned invalid staging JSON");
    defer parsed.deinit();
    const upload_id = jsonString(parsed.value, "uploadId") orelse
        return CommandResult.err(allocator, "Registry staging response is missing uploadId");
    const upload_url = jsonString(parsed.value, "uploadUrl") orelse
        return CommandResult.err(allocator, "Registry staging response is missing uploadUrl");

    style.print("  Streaming artifact to untrusted staging...\n", .{});
    const upload = try io_helper.childRun(allocator, &.{
        "curl",       "-fsS",     "--connect-timeout",  "30", "--speed-limit", "1024", "--speed-time",                   "120",
        "--retry",    "3",        "--retry-all-errors", "-X", "PUT",           "-H",   "Content-Type: application/gzip", "-T",
        tarball_path, upload_url,
    });
    defer allocator.free(upload.stdout);
    defer allocator.free(upload.stderr);
    if (commandFailed(upload))
        return safeCommandError(allocator, "Staging upload failed", upload.stderr);

    const complete_url = try std.fmt.allocPrint(allocator, "{s}/api/v1/binaries/uploads/complete", .{std.mem.trimEnd(u8, registry, "/")});
    defer allocator.free(complete_url);
    const complete_json = try std.fmt.allocPrint(allocator, "{{\"uploadId\":\"{s}\"}}", .{upload_id});
    defer allocator.free(complete_json);

    style.print("  Waiting for malware scan and promotion...\n", .{});
    const complete = try io_helper.childRun(allocator, &.{
        "curl",          "-fsS",        "-X",         "POST", "-H", auth_header, "-H", "Content-Type: application/json",
        "--data-binary", complete_json, complete_url,
    });
    defer allocator.free(complete.stdout);
    defer allocator.free(complete.stderr);
    if (commandFailed(complete))
        return safeCommandError(allocator, "Registry scan/promotion failed", complete.stderr);

    var completed = std.json.parseFromSlice(std.json.Value, allocator, complete.stdout, .{}) catch
        return CommandResult.err(allocator, "Registry returned invalid completion JSON");
    defer completed.deinit();
    if (jsonBool(completed.value, "success") != true)
        return CommandResult.err(allocator, "Registry did not confirm binary promotion");

    style.print("\n✓ Published {s}@{s} ({s}) with a clean malware verdict\n", .{
        options.domain, options.version, platform,
    });
    return .{ .exit_code = 0 };
}
