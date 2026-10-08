//! npm's trusted publishing API: which CI workflows may publish a package
//! with OIDC instead of a token.
//!
//! It is what `npm trust` talks to (npm 11.10+, lib/trust-cmd.js):
//!
//!   GET    /-/package/<name>/trust        the package's trust configurations
//!   POST   /-/package/<name>/trust        add some: a JSON array of them
//!   DELETE /-/package/<name>/trust/<id>   remove one
//!
//! where <name> is npm's escaped name (`@scope%2fname`), and a configuration
//! is `{ type, claims, permissions }`:
//!
//!   { "type": "github",
//!     "claims": { "repository": "owner/repo",
//!                 "workflow_ref": { "file": "release.yml" },
//!                 "environment": "npm" },
//!     "permissions": ["createPackage"] }
//!
//! Every call needs two-factor authentication. Without a one-time password
//! npm answers 401 `EOTP`, either asking for a code (sent back as the
//! `npm-otp` header) or, for an account set up for it, with an `authUrl` to
//! approve in the browser and a `doneUrl` to poll until it hands back a token
//! that stands in for the code.

const std = @import("std");
const http = std.http;
const registry = @import("registry.zig");

/// What npm said to one trust request.
pub const Response = struct {
    status: u16,
    body: []const u8,
    /// Seconds to wait before asking again, from `Retry-After`.
    retry_after: ?u32 = null,
    /// npm wants a one-time password: 401 with `otp` in `WWW-Authenticate`,
    /// or a body that says so.
    needs_otp: bool = false,

    pub fn deinit(self: *Response, allocator: std.mem.Allocator) void {
        allocator.free(self.body);
        self.* = undefined;
    }

    pub fn ok(self: Response) bool {
        return self.status >= 200 and self.status < 300;
    }
};

/// One trust request. `id` names a configuration (DELETE); `body` is sent
/// as JSON (POST); `otp` goes in `npm-otp`.
pub fn request(
    client: *registry.RegistryClient,
    method: http.Method,
    package_name: []const u8,
    id: ?[]const u8,
    body: ?[]const u8,
    auth_token: []const u8,
    otp: ?[]const u8,
) !Response {
    const allocator = client.allocator;
    const encoded = try registry.urlEncodePackageName(allocator, package_name);
    defer allocator.free(encoded);
    const url = if (id) |config_id|
        try std.fmt.allocPrint(allocator, "{s}/-/package/{s}/trust/{s}", .{ client.registry_url, encoded, config_id })
    else
        try std.fmt.allocPrint(allocator, "{s}/-/package/{s}/trust", .{ client.registry_url, encoded });
    defer allocator.free(url);
    return send(client, method, url, body, auth_token, otp);
}

fn send(
    client: *registry.RegistryClient,
    method: http.Method,
    url: []const u8,
    body: ?[]const u8,
    auth_token: []const u8,
    otp: ?[]const u8,
) !Response {
    const allocator = client.allocator;
    const auth = try std.fmt.allocPrint(allocator, "Bearer {s}", .{auth_token});
    defer allocator.free(auth);

    var headers: [4]http.Header = undefined;
    var count: usize = 0;
    headers[count] = .{ .name = "Authorization", .value = auth };
    count += 1;
    headers[count] = .{ .name = "Accept", .value = "application/json" };
    count += 1;
    if (body != null) {
        headers[count] = .{ .name = "Content-Type", .value = "application/json" };
        count += 1;
    }
    if (otp) |code| {
        headers[count] = .{ .name = "npm-otp", .value = code };
        count += 1;
    }

    var req = try client.http_client.request(method, try std.Uri.parse(url), .{ .extra_headers = headers[0..count] });
    defer req.deinit();
    if (body) |json| {
        req.transfer_encoding = .{ .content_length = json.len };
        try req.sendBodyComplete(@constCast(json));
    } else {
        try req.sendBodiless();
    }

    var redirect_buffer: [4096]u8 = undefined;
    var response = try req.receiveHead(&redirect_buffer);

    // The head's bytes don't outlive the body read: take what's needed first.
    var retry_after: ?u32 = null;
    var otp_header = false;
    var it = response.head.iterateHeaders();
    while (it.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "retry-after")) {
            retry_after = std.fmt.parseInt(u32, std.mem.trim(u8, header.value, " "), 10) catch null;
        } else if (std.ascii.eqlIgnoreCase(header.name, "www-authenticate")) {
            otp_header = std.ascii.findIgnoreCase(header.value, "otp") != null;
        }
    }
    const status: u16 = @backingInt(response.head.status);

    const raw = response.reader(&.{}).allocRemaining(allocator, std.Io.Limit.limited(1024 * 1024)) catch |err| switch (err) {
        error.StreamTooLong => return error.ResponseTooLarge,
        else => |e| return e,
    };
    defer allocator.free(raw);
    const decoded = try registry.maybeDecompressGzip(allocator, raw);
    defer if (decoded.ptr != raw.ptr) allocator.free(decoded);

    const needs_otp = status == 401 and (otp_header or bodySaysOtp(decoded));
    return .{
        .status = status,
        .body = try allocator.dupe(u8, decoded),
        .retry_after = retry_after,
        .needs_otp = needs_otp,
    };
}

fn bodySaysOtp(body: []const u8) bool {
    return std.mem.indexOf(u8, body, "EOTP") != null or std.ascii.findIgnoreCase(body, "one-time pass") != null;
}

/// npm's own words from an error body: its `error` or `message`, else the
/// body itself, cut short. Owned by the caller.
///
/// The trust endpoints sometimes wrap a JSON error inside another as a
/// string — `{"error":"{\"success\":false,\"error\":\"You must be logged
/// in…\"}"}` — so a field that is itself such a body is read through.
pub fn message(allocator: std.mem.Allocator, body: []const u8) ![]u8 {
    return messageAt(allocator, body, 0);
}

fn messageAt(allocator: std.mem.Allocator, body: []const u8, depth: u8) ![]u8 {
    if (std.json.parseFromSlice(std.json.Value, allocator, body, .{})) |parsed| {
        defer parsed.deinit();
        if (parsed.value == .object) {
            for ([_][]const u8{ "error", "message" }) |key| {
                if (parsed.value.object.get(key)) |v| {
                    if (v == .string and v.string.len > 0) {
                        const inner = std.mem.trim(u8, v.string, &std.ascii.whitespace);
                        if (depth < 2 and inner.len > 0 and inner[0] == '{') return messageAt(allocator, inner, depth + 1);
                        return allocator.dupe(u8, v.string);
                    }
                }
            }
        }
    } else |_| {}
    return allocator.dupe(u8, std.mem.trim(u8, if (body.len > 300) body[0..300] else body, &std.ascii.whitespace));
}

/// Where to approve a request in the browser, when npm offers it.
pub const WebAuth = struct {
    auth_url: []const u8,
    done_url: []const u8,

    pub fn deinit(self: *WebAuth, allocator: std.mem.Allocator) void {
        allocator.free(self.auth_url);
        allocator.free(self.done_url);
        self.* = undefined;
    }
};

/// The `authUrl` and `doneUrl` of an EOTP answer, if it has them; else the
/// account uses codes from an authenticator.
pub fn webAuth(allocator: std.mem.Allocator, body: []const u8) ?WebAuth {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, body, .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;
    const auth_url = parsed.value.object.get("authUrl") orelse return null;
    const done_url = parsed.value.object.get("doneUrl") orelse return null;
    if (auth_url != .string or done_url != .string) return null;
    if (!std.mem.startsWith(u8, auth_url.string, "https://") or !std.mem.startsWith(u8, done_url.string, "https://")) return null;
    const auth_copy = allocator.dupe(u8, auth_url.string) catch return null;
    const done_copy = allocator.dupe(u8, done_url.string) catch {
        allocator.free(auth_copy);
        return null;
    };
    return .{ .auth_url = auth_copy, .done_url = done_copy };
}

/// Wait for the browser approval: poll `doneUrl` while it answers 202, as
/// long as it says to between polls, until it hands back the token that
/// stands in for a one-time password. Gives up after `timeout_s`.
pub fn awaitWebAuth(client: *registry.RegistryClient, done_url: []const u8, auth_token: []const u8, timeout_s: u32) ![]const u8 {
    const allocator = client.allocator;
    var waited: u32 = 0;
    while (true) {
        var response = try send(client, .GET, done_url, null, auth_token, null);
        defer response.deinit(allocator);
        if (response.status == 200) {
            const parsed = try std.json.parseFromSlice(std.json.Value, allocator, response.body, .{});
            defer parsed.deinit();
            if (parsed.value == .object) {
                if (parsed.value.object.get("token")) |token| {
                    if (token == .string and token.string.len > 0) return allocator.dupe(u8, token.string);
                }
            }
            return error.WebAuthInvalidResponse;
        }
        if (response.status != 202) return error.WebAuthFailed;
        const wait = @max(1, response.retry_after orelse 2);
        if (waited >= timeout_s) return error.WebAuthTimedOut;
        waited += wait;
        @import("../io_helper.zig").sleepMs(@as(u64, wait) * 1000);
    }
}

/// A trust configuration for npm, as a one-element JSON array.
///
/// `kind` is pantry's publisher type: `github-action` (npm's `github`) or
/// `gitlab-ci` (npm's `gitlab`). `repository` is `owner/repo` (GitHub) or the
/// project path (GitLab). `workflow` may be a path; npm wants the file name.
pub fn configBody(
    allocator: std.mem.Allocator,
    kind: []const u8,
    repository: []const u8,
    workflow: []const u8,
    environment: ?[]const u8,
) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    defer out.deinit();
    var json: std.json.Stringify = .{ .writer = &out.writer };
    const file = workflowFile(workflow);

    try json.beginArray();
    try json.beginObject();
    if (isGitHub(kind)) {
        try json.objectField("type");
        try json.write("github");
        try json.objectField("claims");
        try json.beginObject();
        try json.objectField("repository");
        try json.write(repository);
        try json.objectField("workflow_ref");
        try json.beginObject();
        try json.objectField("file");
        try json.write(file);
        try json.endObject();
    } else if (isGitLab(kind)) {
        try json.objectField("type");
        try json.write("gitlab");
        try json.objectField("claims");
        try json.beginObject();
        try json.objectField("project_path");
        try json.write(repository);
        try json.objectField("ci_config_ref_uri");
        try json.beginObject();
        try json.objectField("file");
        try json.write(file);
        try json.endObject();
    } else return error.UnsupportedPublisherType;
    if (environment) |env| {
        try json.objectField("environment");
        try json.write(env);
    }
    try json.endObject(); // claims
    try json.objectField("permissions");
    try json.beginArray();
    try json.write("createPackage");
    try json.endArray();
    try json.endObject();
    try json.endArray();
    return out.toOwnedSlice();
}

pub fn isGitHub(kind: []const u8) bool {
    return std.mem.eql(u8, kind, "github-action") or std.mem.eql(u8, kind, "github");
}

pub fn isGitLab(kind: []const u8) bool {
    return std.mem.eql(u8, kind, "gitlab-ci") or std.mem.eql(u8, kind, "gitlab");
}

/// The workflow's file name: npm matches the file, and rejects a path.
pub fn workflowFile(workflow: []const u8) []const u8 {
    const slash = std.mem.lastIndexOfAny(u8, workflow, "/\\") orelse return workflow;
    return workflow[slash + 1 ..];
}

/// Why a package name can't be one npm knows, if it can't. A name pasted
/// from a page can carry a look-alike: `＠` (U+FF20, fullwidth) for `@`,
/// which npm reports only as a bare error.
pub fn nameProblem(name: []const u8) ?[]const u8 {
    if (std.mem.startsWith(u8, name, "\u{FF20}")) return "it starts with '＠' (U+FF20, a fullwidth at sign), not '@'. Retype the @.";
    for (name) |c| {
        if (c >= 0x80) return "it has a character outside ASCII, which no npm package name has. Retype it rather than pasting.";
    }
    if (name.len == 0) return "it is empty.";
    return null;
}

test "a GitHub configuration is npm's shape, with the workflow's file name" {
    const a = std.testing.allocator;
    const body = try configBody(a, "github-action", "stacksjs/ts-maps", ".github/workflows/release.yml", null);
    defer a.free(body);
    try std.testing.expectEqualStrings(
        \\[{"type":"github","claims":{"repository":"stacksjs/ts-maps","workflow_ref":{"file":"release.yml"}},"permissions":["createPackage"]}]
    , body);
}

test "an environment goes in the claims, and GitLab has its own claim names" {
    const a = std.testing.allocator;
    const body = try configBody(a, "gitlab-ci", "group/project", ".gitlab-ci.yml", "production");
    defer a.free(body);
    try std.testing.expectEqualStrings(
        \\[{"type":"gitlab","claims":{"project_path":"group/project","ci_config_ref_uri":{"file":".gitlab-ci.yml"},"environment":"production"},"permissions":["createPackage"]}]
    , body);
    try std.testing.expectError(error.UnsupportedPublisherType, configBody(a, "circleci", "x", "y", null));
}

test "the workflow's file name, from a path or alone" {
    try std.testing.expectEqualStrings("release.yml", workflowFile(".github/workflows/release.yml"));
    try std.testing.expectEqualStrings("release.yml", workflowFile("release.yml"));
}

test "the browser approval npm offers, when it offers one" {
    const a = std.testing.allocator;
    var web = webAuth(a,
        \\{"error":"otp required","authUrl":"https://www.npmjs.com/auth/cli/abc","doneUrl":"https://registry.npmjs.org/-/v1/done?authId=abc"}
    ).?;
    defer web.deinit(a);
    try std.testing.expectEqualStrings("https://www.npmjs.com/auth/cli/abc", web.auth_url);
    try std.testing.expect(webAuth(a, "{\"error\":\"otp required\"}") == null);
    try std.testing.expect(webAuth(a, "{\"authUrl\":\"http://evil\",\"doneUrl\":\"https://x\"}") == null);
    try std.testing.expect(webAuth(a, "not json") == null);
}

test "a pasted fullwidth at sign is caught" {
    try std.testing.expect(nameProblem("\u{FF20}ts-maps/react") != null);
    try std.testing.expect(nameProblem("@ts-maps/react") == null);
    try std.testing.expect(nameProblem("ts-maps") == null);
}

test "npm's message is read out of its error body" {
    const a = std.testing.allocator;
    const m = try message(a, "{\"success\":false,\"error\":\"You must be logged in to publish packages.\"}");
    defer a.free(m);
    try std.testing.expectEqualStrings("You must be logged in to publish packages.", m);
    const wrapped = try message(a, "{\"error\":\"{\\\"success\\\":false,\\\"error\\\":\\\"You must be logged in to publish packages.\\\"}\"}");
    defer a.free(wrapped);
    try std.testing.expectEqualStrings("You must be logged in to publish packages.", wrapped);
    const raw = try message(a, "Not Found\n");
    defer a.free(raw);
    try std.testing.expectEqualStrings("Not Found", raw);
}

test "npm's ways of asking for a one-time password" {
    try std.testing.expect(bodySaysOtp("{\"code\":\"EOTP\"}"));
    try std.testing.expect(bodySaysOtp("This operation requires a one-time password"));
    try std.testing.expect(!bodySaysOtp("{\"error\":\"not found\"}"));
}
