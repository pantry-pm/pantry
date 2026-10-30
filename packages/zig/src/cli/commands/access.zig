//! Private packages — who may install them.
//!
//!   pantry access list <package>                        Who has access
//!   pantry access grant <package> <email> [--expires-in-days N]
//!   pantry access revoke <package> <email>
//!   pantry access token <package> --name <label> [--expires-in-days N]
//!   pantry access tokens <package>                      Package tokens issued
//!   pantry access token-revoke <package> <id>
//!
//! A package is private when its manifest says `"publishConfig": { "access":
//! "restricted" }` at publish time. Its publisher then decides who can install
//! it: registry accounts (by email), or package tokens - read-only credentials
//! scoped to this one package, meant for a client's CI as
//! `PANTRY_REGISTRY_TOKEN`.
//!
//! Every call goes to the registry named by `--registry`, else
//! `PANTRY_REGISTRY_URL`, else the public registry, authenticated the way
//! `pantry publish` is: `--token`, the environment, then the credential
//! `pantry token set` stored. The registry decides who may change access; these
//! commands surface what it says.

const std = @import("std");
const io_helper = @import("../../io_helper.zig");
const common = @import("common.zig");
const registry_ops = @import("registry_ops.zig");
const endpoint = @import("../../registry/endpoint.zig");
const scopes = @import("../../registry/scopes.zig");

const CommandResult = common.CommandResult;

pub const Options = struct {
    registry: ?[]const u8 = null,
    token: ?[]const u8 = null,
    package: []const u8,
    /// grant / revoke.
    email: ?[]const u8 = null,
    /// token: a label for the token (`--name`).
    name: ?[]const u8 = null,
    /// grant / token: `--expires-in-days`.
    expires_in_days: ?[]const u8 = null,
    /// token-revoke: the token's id.
    id: ?[]const u8 = null,
};

// ---------------------------------------------------------------------------
// Request shapes (pure)
// ---------------------------------------------------------------------------

fn registryUrl(arena: std.mem.Allocator, explicit: ?[]const u8) []const u8 {
    if (registry_ops.resolveRegistryUrl(arena, explicit)) |url| return url;
    return endpoint.baseUrl();
}

/// `{base}/packages/@hq%2Fplatform/access`.
pub fn accessUrl(arena: std.mem.Allocator, base: []const u8, package: []const u8) ![]u8 {
    return scopes.packageUrl(arena, base, package, "/access");
}

/// `{base}/packages/{name}/tokens`, or `/tokens/{id}` for one token.
pub fn tokensUrl(arena: std.mem.Allocator, base: []const u8, package: []const u8, id: ?[]const u8) ![]u8 {
    if (id) |token_id| {
        const suffix = try std.fmt.allocPrint(arena, "/tokens/{s}", .{token_id});
        return scopes.packageUrl(arena, base, package, suffix);
    }
    return scopes.packageUrl(arena, base, package, "/tokens");
}

pub const ArgError = error{ InvalidPackage, InvalidEmail, InvalidDays, InvalidTokenId, MissingName };

/// A package name, scoped or not, with nothing that could escape its path
/// segment.
pub fn validatePackage(package: []const u8) ArgError!void {
    if (package.len == 0 or package.len > 214) return error.InvalidPackage;
    if (std.mem.indexOf(u8, package, "..") != null) return error.InvalidPackage;
    for (package) |c| {
        if (c <= ' ' or c == '?' or c == '#' or c == '%' or c == '\\') return error.InvalidPackage;
    }
    if (package[0] == '@') {
        const scope = scopes.scopeOf(package) orelse return error.InvalidPackage;
        const rest = package[scope.len + 1 ..];
        if (rest.len == 0 or std.mem.indexOfScalar(u8, rest, '/') != null) return error.InvalidPackage;
    } else if (std.mem.indexOfScalar(u8, package, '/') != null) {
        return error.InvalidPackage;
    }
}

/// Enough of an address to be worth sending; the registry is the real judge.
pub fn validateEmail(email: []const u8) ArgError!void {
    const at = std.mem.indexOfScalar(u8, email, '@') orelse return error.InvalidEmail;
    if (at == 0 or at == email.len - 1) return error.InvalidEmail;
    if (std.mem.indexOfScalarPos(u8, email, at + 1, '@') != null) return error.InvalidEmail;
    for (email) |c| {
        if (c <= ' ' or c == '"' or c == '\\') return error.InvalidEmail;
    }
}

/// `--expires-in-days`: a whole number of days, 1 to 3650. Null when absent.
pub fn parseExpiresInDays(raw: ?[]const u8) ArgError!?u32 {
    const text = std.mem.trim(u8, raw orelse return null, &std.ascii.whitespace);
    if (text.len == 0) return null;
    const days = std.fmt.parseInt(u32, text, 10) catch return error.InvalidDays;
    if (days == 0 or days > 3650) return error.InvalidDays;
    return days;
}

/// Token ids go into a URL path.
pub fn validateTokenId(id: []const u8) ArgError!void {
    if (id.len == 0 or id.len > 128) return error.InvalidTokenId;
    for (id) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '-' or c == '_' or c == '.')) return error.InvalidTokenId;
    }
}

/// RFC 3339 UTC for a Unix time.
pub fn formatTimestamp(arena: std.mem.Allocator, unix_seconds: i64) ![]u8 {
    const epoch_seconds = std.time.epoch.EpochSeconds{ .secs = @intCast(@max(unix_seconds, 0)) };
    const epoch_day = epoch_seconds.getEpochDay();
    const year_day = epoch_day.calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day_seconds = epoch_seconds.getDaySeconds();
    return std.fmt.allocPrint(arena, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}Z", .{
        year_day.year,
        @as(u8, @backingInt(month_day.month)),
        month_day.day_index + 1,
        day_seconds.getHoursIntoDay(),
        day_seconds.getMinutesIntoHour(),
        day_seconds.getSecondsIntoMinute(),
    });
}

/// `PUT /access` body: `{"email":…,"expiresAt":"<RFC 3339>"}`, the expiry
/// left out for a grant that does not expire.
pub fn grantBody(arena: std.mem.Allocator, email: []const u8, expires_in_days: ?u32, now_unix: i64) ![]u8 {
    var body: std.ArrayList(u8) = .empty;
    try body.appendSlice(arena, "{\"email\":");
    try registry_ops.appendJsonString(&body, arena, email);
    if (expires_in_days) |days| {
        const expires_at = try formatTimestamp(arena, now_unix + @as(i64, days) * std.time.s_per_day);
        try body.appendSlice(arena, ",\"expiresAt\":");
        try registry_ops.appendJsonString(&body, arena, expires_at);
    }
    try body.append(arena, '}');
    return body.items;
}

/// `DELETE /access` body: `{"email":…}`.
pub fn revokeBody(arena: std.mem.Allocator, email: []const u8) ![]u8 {
    var body: std.ArrayList(u8) = .empty;
    try body.appendSlice(arena, "{\"email\":");
    try registry_ops.appendJsonString(&body, arena, email);
    try body.append(arena, '}');
    return body.items;
}

/// `POST /tokens` body: `{"name":…,"expiresInDays":N}`, the expiry left out
/// when not asked for (the registry applies its default).
pub fn tokenBody(arena: std.mem.Allocator, name: []const u8, expires_in_days: ?u32) ![]u8 {
    var body: std.ArrayList(u8) = .empty;
    try body.appendSlice(arena, "{\"name\":");
    try registry_ops.appendJsonString(&body, arena, name);
    if (expires_in_days) |days| {
        var days_buf: [32]u8 = undefined;
        try body.appendSlice(arena, try std.fmt.bufPrint(&days_buf, ",\"expiresInDays\":{d}", .{days}));
    }
    try body.append(arena, '}');
    return body.items;
}

fn stringField(obj: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = obj.get(key) orelse return null;
    return if (value == .string) value.string else null;
}

/// `{ grants: [{ subject, email?, name?, expiresAt, createdAt }] }` as lines.
pub fn formatGrants(arena: std.mem.Allocator, package: []const u8, body: []const u8) ![]const u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, arena, body, .{}) catch return error.InvalidResponse;
    if (parsed.value != .object) return error.InvalidResponse;
    const grants = parsed.value.object.get("grants") orelse return error.InvalidResponse;
    if (grants != .array) return error.InvalidResponse;

    var out: std.ArrayList(u8) = .empty;
    if (grants.array.items.len == 0) {
        try out.print(arena, "Nobody else has access to {s}.\n\nGrant it with:  pantry access grant {s} <email>", .{ package, package });
        return out.items;
    }
    try out.print(arena, "Access to {s} ({d}):\n", .{ package, grants.array.items.len });
    for (grants.array.items) |grant| {
        if (grant != .object) continue;
        const who = stringField(grant.object, "email") orelse stringField(grant.object, "subject") orelse "(unknown)";
        try out.print(arena, "\n  {s}", .{who});
        if (stringField(grant.object, "name")) |name| try out.print(arena, " ({s})", .{name});
        if (stringField(grant.object, "subject")) |subject| {
            if (!std.mem.eql(u8, subject, who)) try out.print(arena, "  [{s}]", .{subject});
        }
        try out.print(arena, "\n    expires: {s}", .{stringField(grant.object, "expiresAt") orelse "never"});
        if (stringField(grant.object, "createdAt")) |created| try out.print(arena, "   granted: {s}", .{created});
    }
    return out.items;
}

/// `{ tokens: [{ id, name, expiresAt, createdAt, lastUsedAt? }] }` as lines.
pub fn formatTokens(arena: std.mem.Allocator, package: []const u8, body: []const u8) ![]const u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, arena, body, .{}) catch return error.InvalidResponse;
    if (parsed.value != .object) return error.InvalidResponse;
    const tokens = parsed.value.object.get("tokens") orelse return error.InvalidResponse;
    if (tokens != .array) return error.InvalidResponse;

    var out: std.ArrayList(u8) = .empty;
    if (tokens.array.items.len == 0) {
        try out.print(arena, "No package tokens for {s}.\n\nIssue one with:  pantry access token {s} --name <label>", .{ package, package });
        return out.items;
    }
    try out.print(arena, "Package tokens for {s} ({d}):\n", .{ package, tokens.array.items.len });
    for (tokens.array.items) |token| {
        if (token != .object) continue;
        try out.print(arena, "\n  {s}  {s}", .{ stringField(token.object, "id") orelse "?", stringField(token.object, "name") orelse "" });
        try out.print(arena, "\n    expires: {s}", .{stringField(token.object, "expiresAt") orelse "never"});
        if (stringField(token.object, "createdAt")) |created| try out.print(arena, "   created: {s}", .{created});
        try out.print(arena, "   last used: {s}", .{stringField(token.object, "lastUsedAt") orelse "never"});
    }
    return out.items;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const Session = struct {
    url: []const u8,
    headers: []const std.http.Header,
};

fn signInMessage(arena: std.mem.Allocator, url: []const u8) []const u8 {
    return std.fmt.allocPrint(arena,
        \\Error: no credential for {s}.
        \\
        \\Changing who can install a package needs the publisher's token:
        \\
        \\  pantry token set --registry {s}
        \\
        \\or set PANTRY_REGISTRY_TOKEN / PANTRY_TOKEN, or pass --token.
    , .{ url, url }) catch "Error: no credential for this registry.";
}

fn argMessage(err: ArgError) []const u8 {
    return switch (err) {
        error.InvalidPackage => "Error: that is not a package name (e.g. my-package or @scope/name).",
        error.InvalidEmail => "Error: an email address is required, e.g. dev@client.com.",
        error.InvalidDays => "Error: --expires-in-days must be a whole number of days between 1 and 3650.",
        error.InvalidTokenId => "Error: a token id is required (see `pantry access tokens <package>`).",
        error.MissingName => "Error: --name is required: a label for the token, e.g. --name acme-ci.",
    };
}

/// The registry, the credential and the package, or the error to print.
fn begin(arena: std.mem.Allocator, opts: Options) union(enum) { ok: Session, fail: []const u8 } {
    validatePackage(opts.package) catch |err| return .{ .fail = argMessage(err) };
    const url = registryUrl(arena, opts.registry);
    const token = registry_ops.credentialFor(arena, opts.token, url) orelse return .{ .fail = signInMessage(arena, url) };
    const value = std.fmt.allocPrint(arena, "Bearer {s}", .{token}) catch return .{ .fail = "Error: out of memory." };
    const headers = arena.alloc(std.http.Header, 1) catch return .{ .fail = "Error: out of memory." };
    headers[0] = .{ .name = "Authorization", .value = value };
    return .{ .ok = .{ .url = url, .headers = headers } };
}

fn request(arena: std.mem.Allocator, session: Session, method: std.http.Method, target: []const u8, body: ?[]const u8) ?io_helper.HttpResponse {
    return io_helper.httpRequest(arena, method, target, body, session.headers) catch null;
}

/// What to add to the registry's own error for a management call.
pub fn failureHint(status: u16) []const u8 {
    return switch (status) {
        401 => "\nThe token was not accepted for this. Managing access needs the publisher's own token - a read-only or package token cannot do it (see `pantry token list`).",
        403 => "\nYou can install this package, but only its publisher (or their team) can change who has access.",
        404 => "\nNo such package on this registry - or it is private and this account has no access to it.",
        402 => "\nPrivate packages need a Pro or Team plan: pantry subscribe pro",
        else => "",
    };
}

fn failure(allocator: std.mem.Allocator, arena: std.mem.Allocator, what: []const u8, res: io_helper.HttpResponse) !CommandResult {
    return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not {s}: {s}{s}", .{ what, registry_ops.apiError(arena, res), failureHint(res.status) }));
}

fn unreachable_(allocator: std.mem.Allocator, arena: std.mem.Allocator, url: []const u8) !CommandResult {
    return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));
}

pub fn listCommand(allocator: std.mem.Allocator, opts: Options) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const session = switch (begin(arena, opts)) {
        .ok => |s| s,
        .fail => |m| return CommandResult.err(allocator, m),
    };
    const res = request(arena, session, .GET, try accessUrl(arena, session.url, opts.package), null) orelse
        return unreachable_(allocator, arena, session.url);
    if (!res.ok()) return failure(allocator, arena, "list access", res);

    const text = formatGrants(arena, opts.package, res.body) catch
        return CommandResult.err(allocator, "The registry returned a response this version doesn't understand.");
    return CommandResult.success(allocator, text);
}

pub fn grantCommand(allocator: std.mem.Allocator, opts: Options) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const email = opts.email orelse return CommandResult.err(allocator, argMessage(error.InvalidEmail));
    validateEmail(email) catch |err| return CommandResult.err(allocator, argMessage(err));
    const days = parseExpiresInDays(opts.expires_in_days) catch |err| return CommandResult.err(allocator, argMessage(err));

    const session = switch (begin(arena, opts)) {
        .ok => |s| s,
        .fail => |m| return CommandResult.err(allocator, m),
    };
    const body = try grantBody(arena, email, days, @intCast(io_helper.clockGettime().sec));
    const res = request(arena, session, .PUT, try accessUrl(arena, session.url, opts.package), body) orelse
        return unreachable_(allocator, arena, session.url);
    if (!res.ok()) return failure(allocator, arena, "grant access", res);

    const expiry = blk: {
        const parsed = std.json.parseFromSlice(std.json.Value, arena, res.body, .{}) catch break :blk null;
        if (parsed.value != .object) break :blk null;
        const grant = parsed.value.object.get("grant") orelse break :blk null;
        if (grant != .object) break :blk null;
        break :blk stringField(grant.object, "expiresAt");
    };
    return CommandResult.success(allocator, try std.fmt.allocPrint(arena,
        \\Granted {s} access to {s}{s}{s}.
        \\
        \\They install it with their own registry token, or in CI with a package
        \\token:  pantry access token {s} --name <label>
    , .{ email, opts.package, if (expiry != null) " until " else "", expiry orelse "", opts.package }));
}

pub fn revokeCommand(allocator: std.mem.Allocator, opts: Options) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const email = opts.email orelse return CommandResult.err(allocator, argMessage(error.InvalidEmail));
    validateEmail(email) catch |err| return CommandResult.err(allocator, argMessage(err));

    const session = switch (begin(arena, opts)) {
        .ok => |s| s,
        .fail => |m| return CommandResult.err(allocator, m),
    };
    const res = request(arena, session, .DELETE, try accessUrl(arena, session.url, opts.package), try revokeBody(arena, email)) orelse
        return unreachable_(allocator, arena, session.url);
    // The registry answers 404 for a grant that does not exist.
    if (res.status == 404) return CommandResult.err(allocator, try std.fmt.allocPrint(arena,
        \\{s} has no grant on {s} (or the package does not exist, or this account cannot see it).
        \\See who does:  pantry access list {s}
    , .{ email, opts.package, opts.package }));
    if (!res.ok()) return failure(allocator, arena, "revoke access", res);

    return CommandResult.success(allocator, try std.fmt.allocPrint(arena, "Revoked {s}'s access to {s}. Their next install of it is refused.", .{ email, opts.package }));
}

pub fn tokenCreateCommand(allocator: std.mem.Allocator, opts: Options) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const name = std.mem.trim(u8, opts.name orelse "", &std.ascii.whitespace);
    if (name.len == 0) return CommandResult.err(allocator, argMessage(error.MissingName));
    const days = parseExpiresInDays(opts.expires_in_days) catch |err| return CommandResult.err(allocator, argMessage(err));

    const session = switch (begin(arena, opts)) {
        .ok => |s| s,
        .fail => |m| return CommandResult.err(allocator, m),
    };
    const res = request(arena, session, .POST, try tokensUrl(arena, session.url, opts.package, null), try tokenBody(arena, name, days)) orelse
        return unreachable_(allocator, arena, session.url);
    if (!res.ok()) return failure(allocator, arena, "issue a package token", res);

    const parsed = std.json.parseFromSlice(std.json.Value, arena, res.body, .{}) catch
        return CommandResult.err(allocator, "The registry returned a response this version doesn't understand.");
    if (parsed.value != .object) return CommandResult.err(allocator, "The registry did not return a token.");
    const token = stringField(parsed.value.object, "token") orelse
        return CommandResult.err(allocator, "The registry did not return a token.");
    const id = stringField(parsed.value.object, "id") orelse "?";
    const expires = stringField(parsed.value.object, "expiresAt") orelse "never";

    // Printed once: the registry keeps only a hash.
    return CommandResult.success(allocator, try std.fmt.allocPrint(arena,
        \\Issued package token "{s}" for {s} (id {s}, expires {s}).
        \\It is shown once:
        \\
        \\  {s}
        \\
        \\It can install {s} and nothing else. Store it as PANTRY_REGISTRY_TOKEN in
        \\the client's CI, e.g.:
        \\
        \\  echo '{s}' | gh secret set PANTRY_REGISTRY_TOKEN --repo <owner>/<repo>
        \\
        \\Revoke it with:
        \\
        \\  pantry access token-revoke {s} {s}
    , .{ name, opts.package, id, expires, token, opts.package, token, opts.package, id }));
}

pub fn tokensCommand(allocator: std.mem.Allocator, opts: Options) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const session = switch (begin(arena, opts)) {
        .ok => |s| s,
        .fail => |m| return CommandResult.err(allocator, m),
    };
    const res = request(arena, session, .GET, try tokensUrl(arena, session.url, opts.package, null), null) orelse
        return unreachable_(allocator, arena, session.url);
    if (!res.ok()) return failure(allocator, arena, "list package tokens", res);

    const text = formatTokens(arena, opts.package, res.body) catch
        return CommandResult.err(allocator, "The registry returned a response this version doesn't understand.");
    return CommandResult.success(allocator, text);
}

pub fn tokenRevokeCommand(allocator: std.mem.Allocator, opts: Options) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const id = opts.id orelse return CommandResult.err(allocator, argMessage(error.InvalidTokenId));
    validateTokenId(id) catch |err| return CommandResult.err(allocator, argMessage(err));

    const session = switch (begin(arena, opts)) {
        .ok => |s| s,
        .fail => |m| return CommandResult.err(allocator, m),
    };
    const res = request(arena, session, .DELETE, try tokensUrl(arena, session.url, opts.package, id), null) orelse
        return unreachable_(allocator, arena, session.url);
    // The registry answers 404 for a token id it does not know.
    if (res.status == 404) return CommandResult.err(allocator, try std.fmt.allocPrint(arena,
        \\{s} has no package token {s} (it may already be revoked).
        \\See its tokens:  pantry access tokens {s}
    , .{ opts.package, id, opts.package }));
    if (!res.ok()) return failure(allocator, arena, "revoke the package token", res);

    return CommandResult.success(allocator, try std.fmt.allocPrint(arena, "Revoked package token {s} for {s}. The next install with it is refused.", .{ id, opts.package }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "access: URLs encode scoped names the way /packages calls do" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try testing.expectEqualStrings("https://registry.pantry.dev/packages/@hq%2Fplatform/access", try accessUrl(arena, "https://registry.pantry.dev", "@hq/platform"));
    try testing.expectEqualStrings("https://r.test/packages/left-pad/access", try accessUrl(arena, "https://r.test", "left-pad"));
    try testing.expectEqualStrings("https://r.test/packages/@hq%2Fplatform/tokens", try tokensUrl(arena, "https://r.test", "@hq/platform", null));
    try testing.expectEqualStrings("https://r.test/packages/@hq%2Fplatform/tokens/tok_123", try tokensUrl(arena, "https://r.test", "@hq/platform", "tok_123"));
}

test "access: argument validation" {
    try validatePackage("@hq/platform");
    try validatePackage("left-pad");
    for ([_][]const u8{ "", "@hq", "@hq/", "@hq/a/b", "a/b", "../x", "x?y", "x y", "@/x" }) |bad| {
        try testing.expectError(error.InvalidPackage, validatePackage(bad));
    }

    try validateEmail("dev@client.com");
    for ([_][]const u8{ "", "dev", "@client.com", "dev@", "a@b@c", "dev @client.com", "d\"@x.y" }) |bad| {
        try testing.expectError(error.InvalidEmail, validateEmail(bad));
    }

    try testing.expectEqual(@as(?u32, null), try parseExpiresInDays(null));
    try testing.expectEqual(@as(?u32, 30), try parseExpiresInDays("30"));
    try testing.expectEqual(@as(?u32, 365), try parseExpiresInDays(" 365 "));
    for ([_][]const u8{ "0", "-1", "abc", "3651", "1.5" }) |bad| {
        try testing.expectError(error.InvalidDays, parseExpiresInDays(bad));
    }

    try validateTokenId("tok_01HXYZ-abc");
    for ([_][]const u8{ "", "a/b", "../x", "id?x=1" }) |bad| {
        try testing.expectError(error.InvalidTokenId, validateTokenId(bad));
    }
}

test "access: request bodies match the registry contract" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    // 2026-01-01T00:00:00Z + 30 days.
    const now: i64 = 1767225600;
    try testing.expectEqualStrings(
        \\{"email":"dev@client.com","expiresAt":"2026-01-31T00:00:00Z"}
    , try grantBody(arena, "dev@client.com", 30, now));
    try testing.expectEqualStrings(
        \\{"email":"dev@client.com"}
    , try grantBody(arena, "dev@client.com", null, now));
    try testing.expectEqualStrings(
        \\{"email":"dev@client.com"}
    , try revokeBody(arena, "dev@client.com"));
    try testing.expectEqualStrings(
        \\{"name":"acme-ci","expiresInDays":90}
    , try tokenBody(arena, "acme-ci", 90));
    try testing.expectEqualStrings(
        \\{"name":"say \"hi\""}
    , try tokenBody(arena, "say \"hi\"", null));
}

test "access: grant and token listings render" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const grants = try formatGrants(arena, "@hq/platform",
        \\{"grants":[{"subject":"user:42","email":"dev@client.com","name":"Dev","expiresAt":null,"createdAt":"2026-10-30T00:00:00Z"},
        \\           {"subject":"token:tok_1","expiresAt":"2027-01-01T00:00:00Z","createdAt":"2026-10-30T00:00:00Z"}]}
    );
    try testing.expect(std.mem.indexOf(u8, grants, "dev@client.com (Dev)") != null);
    try testing.expect(std.mem.indexOf(u8, grants, "expires: never") != null);
    try testing.expect(std.mem.indexOf(u8, grants, "token:tok_1") != null);

    const none = try formatGrants(arena, "@hq/platform",
        \\{"grants":[]}
    );
    try testing.expect(std.mem.indexOf(u8, none, "pantry access grant @hq/platform") != null);

    const tokens = try formatTokens(arena, "@hq/platform",
        \\{"tokens":[{"id":"tok_1","name":"acme-ci","expiresAt":"2027-01-01T00:00:00Z","createdAt":"2026-10-30T00:00:00Z"}]}
    );
    try testing.expect(std.mem.indexOf(u8, tokens, "tok_1  acme-ci") != null);
    try testing.expect(std.mem.indexOf(u8, tokens, "last used: never") != null);

    try testing.expectError(error.InvalidResponse, formatGrants(arena, "x", "[]"));

    // Management-route statuses each say what is actually wrong.
    try testing.expect(std.mem.indexOf(u8, failureHint(401), "read-only") != null);
    try testing.expect(std.mem.indexOf(u8, failureHint(403), "only its publisher") != null);
    try testing.expect(std.mem.indexOf(u8, failureHint(404), "private") != null);
    try testing.expectEqualStrings("", failureHint(500));
    try testing.expectError(error.InvalidResponse, formatTokens(arena, "x", "{\"grants\":[]}"));
}
