//! `pantry login`: log in to npm in the browser, as `npm login` does, without
//! needing npm.
//!
//! npm's web login: POST /-/v1/login answers with a `loginUrl` to open and a
//! `doneUrl` to poll. Once you've signed in — with two-factor — the poll hands
//! back a token, which goes into your npmrc as
//! `//registry.npmjs.org/:_authToken=…`, where pantry and npm both read it.
//!
//! That token is a login session, which matters now: npm turns away tokens
//! that skip two-factor for account changes such as trusted publishing
//! (`pantry publisher:add`), and a session is what it accepts.

const std = @import("std");
const builtin = @import("builtin");
const io_helper = @import("../../io_helper.zig");
const style = @import("../style.zig");
const common = @import("common.zig");
const CommandResult = common.CommandResult;
const npm_trust = @import("../../auth/npm_trust.zig");
const registry = @import("../../auth/registry.zig");

/// What npm's own client sends: without `npm-auth-type: web` the registry
/// answers a login as if it were an unauthenticated publish.
const web_login_headers = [_]std.http.Header{
    .{ .name = "npm-auth-type", .value = "web" },
    .{ .name = "npm-command", .value = "login" },
};

pub const LoginOptions = struct {
    registry: []const u8 = "https://registry.npmjs.org",
};

pub fn loginCommand(allocator: std.mem.Allocator, options: LoginOptions) !CommandResult {
    const base = std.mem.trimEnd(u8, options.registry, "/");
    var client = try registry.RegistryClient.init(allocator, base);
    defer client.deinit();

    const start_url = try std.fmt.allocPrint(allocator, "{s}/-/v1/login", .{base});
    defer allocator.free(start_url);
    var started = npm_trust.send(&client, .POST, start_url, "{}", null, null, &web_login_headers) catch |err| {
        const msg = try std.fmt.allocPrint(allocator, "Error: Could not reach {s}: {any}", .{ base, err });
        return CommandResult.err(allocator, msg);
    };
    defer started.deinit(allocator);
    if (!started.ok()) {
        const said = try npm_trust.message(allocator, started.body);
        defer allocator.free(said);
        const msg = try std.fmt.allocPrint(allocator, "Error: {s} doesn't offer browser login ({d} {s})", .{ base, started.status, said });
        return CommandResult.err(allocator, msg);
    }
    var pair = npm_trust.urlPair(allocator, started.body, "loginUrl") orelse {
        return CommandResult.err(allocator, "Error: The registry's login answer had no login page to open");
    };
    defer pair.deinit(allocator);

    style.print("Log in to npm in your browser:\n  {s}\n", .{pair.auth_url});
    _ = openInBrowser(allocator, pair.auth_url);
    style.print("Waiting for you to finish...\n", .{});

    const token = npm_trust.awaitWebAuth(&client, pair.done_url, null, 600, &web_login_headers) catch |err| {
        const msg = try std.fmt.allocPrint(allocator, "Error: Login didn't complete ({any})", .{err});
        return CommandResult.err(allocator, msg);
    };
    defer allocator.free(token);

    const path = try npmrcPath(allocator);
    defer allocator.free(path);
    const existing = io_helper.readFileAlloc(allocator, path, 1024 * 1024) catch try allocator.dupe(u8, "");
    defer allocator.free(existing);
    const updated = try withAuthToken(allocator, existing, base, token);
    defer allocator.free(updated);
    writePrivate(allocator, path, updated) catch |err| {
        const msg = try std.fmt.allocPrint(allocator, "Error: Logged in, but could not save the token to {s}: {any}", .{ path, err });
        return CommandResult.err(allocator, msg);
    };

    // Who that is, as a check the token works.
    const whoami_url = try std.fmt.allocPrint(allocator, "{s}/-/whoami", .{base});
    defer allocator.free(whoami_url);
    var who = npm_trust.send(&client, .GET, whoami_url, null, token, null, &.{}) catch null;
    defer if (who) |*w| w.deinit(allocator);
    const username = if (who) |w| usernameOf(allocator, w.body) else null;
    defer if (username) |u| allocator.free(u);

    if (username) |u| {
        style.print("\n✓ Logged in as {s}. The token is in {s}.\n", .{ u, path });
    } else {
        style.print("\n✓ Logged in. The token is in {s}.\n", .{path});
    }
    if (io_helper.getenv("NPM_TOKEN") != null or io_helper.getenv("NODE_AUTH_TOKEN") != null or io_helper.getenv("BUN_AUTH_TOKEN") != null) {
        style.print("Note: NPM_TOKEN (or NODE_AUTH_TOKEN / BUN_AUTH_TOKEN) is set in this shell, and pantry uses it before your npmrc. Unset it to use this login.\n", .{});
    }
    return .{ .exit_code = 0 };
}

/// The user npmrc npm reads: $NPM_CONFIG_USERCONFIG, else ~/.npmrc.
fn npmrcPath(allocator: std.mem.Allocator) ![]u8 {
    if (io_helper.getenv("NPM_CONFIG_USERCONFIG")) |p| {
        if (p.len > 0) return allocator.dupe(u8, p);
    }
    const home = io_helper.getenv(if (builtin.os.tag == .windows) "USERPROFILE" else "HOME") orelse return error.EnvironmentVariableNotFound;
    return std.fs.path.join(allocator, &.{ home, ".npmrc" });
}

/// npm's key for a registry's token: the URL without its scheme, ending in a
/// slash. `https://registry.npmjs.org` → `//registry.npmjs.org/`.
pub fn registryKey(allocator: std.mem.Allocator, registry_url: []const u8) ![]u8 {
    const rest = if (std.mem.indexOf(u8, registry_url, "://")) |i| registry_url[i + 1 ..] else registry_url;
    const lead: []const u8 = if (std.mem.startsWith(u8, rest, "//")) "" else "//";
    const tail: []const u8 = if (std.mem.endsWith(u8, rest, "/")) "" else "/";
    return std.fmt.allocPrint(allocator, "{s}{s}{s}", .{ lead, rest, tail });
}

/// The npmrc `content`, with this registry's `_authToken` set to `token`:
/// the line replaced where there is one, added where there isn't, and every
/// other line kept as it was.
pub fn withAuthToken(allocator: std.mem.Allocator, content: []const u8, registry_url: []const u8, token: []const u8) ![]u8 {
    const key = try registryKey(allocator, registry_url);
    defer allocator.free(key);
    const prefix = try std.fmt.allocPrint(allocator, "{s}:_authToken=", .{key});
    defer allocator.free(prefix);

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var replaced = false;
    var lines = std.mem.splitScalar(u8, content, '\n');
    var first = true;
    while (lines.next()) |line| {
        if (!first) try out.append(allocator, '\n');
        first = false;
        if (std.mem.startsWith(u8, std.mem.trimStart(u8, line, " \t"), prefix)) {
            if (replaced) {
                // A second line for the same registry would win over ours in
                // some readers; drop it.
                _ = out.pop();
                continue;
            }
            try out.appendSlice(allocator, prefix);
            try out.appendSlice(allocator, token);
            replaced = true;
        } else {
            try out.appendSlice(allocator, line);
        }
    }
    if (!replaced) {
        if (out.items.len > 0 and out.items[out.items.len - 1] != '\n') try out.append(allocator, '\n');
        try out.appendSlice(allocator, prefix);
        try out.appendSlice(allocator, token);
        try out.append(allocator, '\n');
    }
    return out.toOwnedSlice(allocator);
}

fn usernameOf(allocator: std.mem.Allocator, body: []const u8) ?[]const u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, body, .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;
    const name = parsed.value.object.get("username") orelse return null;
    if (name != .string or name.string.len == 0) return null;
    return allocator.dupe(u8, name.string) catch null;
}

/// Written beside it, readable by you alone, then moved into place.
fn writePrivate(allocator: std.mem.Allocator, path: []const u8, content: []const u8) !void {
    const tmp = try std.fmt.allocPrint(allocator, "{s}.pantry-tmp", .{path});
    defer allocator.free(tmp);
    {
        const file = try io_helper.createFileAbsolute(tmp, .{});
        defer io_helper.closeFile(file);
        try io_helper.writeAllToFile(file, content);
    }
    errdefer io_helper.deleteFile(tmp) catch {};
    if (comptime builtin.os.tag != .windows) {
        var buf: [std.fs.max_path_bytes:0]u8 = undefined;
        if (tmp.len >= buf.len) return error.NameTooLong;
        @memcpy(buf[0..tmp.len], tmp);
        buf[tmp.len] = 0;
        if (std.c.chmod(@ptrCast(&buf), 0o600) != 0) return error.ChmodFailed;
    }
    try io_helper.rename(tmp, path);
}

fn openInBrowser(allocator: std.mem.Allocator, url: []const u8) bool {
    const argv: []const []const u8 = switch (builtin.os.tag) {
        .macos => &.{ "open", url },
        .windows => &.{ "cmd", "/c", "start", url },
        else => &.{ "xdg-open", url },
    };
    const result = io_helper.childRun(allocator, argv) catch return false;
    allocator.free(result.stdout);
    allocator.free(result.stderr);
    return result.term == .exited and result.term.exited == 0;
}

test "npm's key for a registry" {
    const a = std.testing.allocator;
    const k1 = try registryKey(a, "https://registry.npmjs.org");
    defer a.free(k1);
    try std.testing.expectEqualStrings("//registry.npmjs.org/", k1);
    const k2 = try registryKey(a, "https://npm.example.com/path/");
    defer a.free(k2);
    try std.testing.expectEqualStrings("//npm.example.com/path/", k2);
}

test "a login replaces the registry's token and keeps everything else" {
    const a = std.testing.allocator;
    const before =
        \\registry=https://registry.npmjs.org/
        \\//registry.npmjs.org/:_authToken=npm_old
        \\//npm.example.com/:_authToken=npm_other
        \\
    ;
    const after = try withAuthToken(a, before, "https://registry.npmjs.org", "npm_new");
    defer a.free(after);
    try std.testing.expectEqualStrings(
        \\registry=https://registry.npmjs.org/
        \\//registry.npmjs.org/:_authToken=npm_new
        \\//npm.example.com/:_authToken=npm_other
        \\
    , after);
}

test "a first login adds the line, to an empty npmrc or one without a newline" {
    const a = std.testing.allocator;
    const empty = try withAuthToken(a, "", "https://registry.npmjs.org", "npm_new");
    defer a.free(empty);
    try std.testing.expectEqualStrings("//registry.npmjs.org/:_authToken=npm_new\n", empty);
    const bare = try withAuthToken(a, "save-exact=true", "https://registry.npmjs.org/", "npm_new");
    defer a.free(bare);
    try std.testing.expectEqualStrings("save-exact=true\n//registry.npmjs.org/:_authToken=npm_new\n", bare);
}

test "a duplicate line for the registry goes" {
    const a = std.testing.allocator;
    const after = try withAuthToken(a, "//registry.npmjs.org/:_authToken=a\n//registry.npmjs.org/:_authToken=b\n", "https://registry.npmjs.org", "c");
    defer a.free(after);
    try std.testing.expectEqualStrings("//registry.npmjs.org/:_authToken=c\n", after);
}
