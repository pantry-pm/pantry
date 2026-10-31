//! Retire a package without unpublishing it.
//!
//!   pantry deprecate <package> [message]     Mark it deprecated
//!   pantry deprecate <package> --undo        Take that back
//!
//! A registry keeps every version it published, so there is no unpublish.
//! Deprecating a package leaves every version installable; the registry adds
//! `deprecated: "<message>"` to its metadata (npm's convention) and its page
//! says so, and `pantry install` / `pantry ci` print a one-line warning when
//! they resolve it.
//!
//! The call goes to the registry named by `--registry`, else
//! `PANTRY_REGISTRY_URL`, else the public registry, authenticated the way
//! `pantry access` is: `--token`, the environment, then the credential
//! `pantry token set` stored. The registry decides who may deprecate: the
//! package's publisher, their team, or an admin.

const std = @import("std");
const io_helper = @import("../../io_helper.zig");
const common = @import("common.zig");
const registry_ops = @import("registry_ops.zig");
const access = @import("access.zig");
const endpoint = @import("../../registry/endpoint.zig");
const scopes = @import("../../registry/scopes.zig");

const CommandResult = common.CommandResult;

pub const Options = struct {
    registry: ?[]const u8 = null,
    token: ?[]const u8 = null,
    package: []const u8,
    /// Why, and what to use instead. Optional: the registry has a default.
    message: ?[]const u8 = null,
    /// `--undo`: undeprecate.
    undo: bool = false,
};

/// The registry's own limit on a message.
pub const max_message_len = 1024;

// ---------------------------------------------------------------------------
// Request shapes (pure)
// ---------------------------------------------------------------------------

/// `{base}/packages/@hq%2Fkit-probe/deprecation`.
pub fn deprecationUrl(arena: std.mem.Allocator, base: []const u8, package: []const u8) ![]u8 {
    return scopes.packageUrl(arena, base, package, "/deprecation");
}

/// `PUT /deprecation` body: `{"message":…}`, or `{}` for the default message.
pub fn requestBody(arena: std.mem.Allocator, message: ?[]const u8) ![]u8 {
    const text = std.mem.trim(u8, message orelse "", &std.ascii.whitespace);
    if (text.len == 0) return arena.dupe(u8, "{}");
    var body: std.ArrayList(u8) = .empty;
    try body.appendSlice(arena, "{\"message\":");
    try registry_ops.appendJsonString(&body, arena, text);
    try body.append(arena, '}');
    return body.items;
}

pub const ArgError = error{ MessageWithUndo, MessageTooLong };

pub fn validateArgs(opts: Options) ArgError!void {
    const text = std.mem.trim(u8, opts.message orelse "", &std.ascii.whitespace);
    if (opts.undo and text.len > 0) return error.MessageWithUndo;
    if (text.len > max_message_len) return error.MessageTooLong;
}

/// The message the registry settled on, from `{ name, deprecated, message? }`.
pub fn responseMessage(arena: std.mem.Allocator, body: []const u8) ?[]const u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, arena, body, .{}) catch return null;
    if (parsed.value != .object) return null;
    const value = parsed.value.object.get("message") orelse return null;
    return if (value == .string) value.string else null;
}

/// What to add to the registry's own error.
pub fn failureHint(status: u16) []const u8 {
    return switch (status) {
        401 => "\nThe token was not accepted for this. Deprecating needs a token with publish permission - a read-only or package token cannot do it (see `pantry token list`).",
        403 => "\nOnly the package's publisher, their team, or a registry admin can deprecate it.",
        404 => "\nNo such package on this registry - or it is private and this account has no access to it.",
        else => "",
    };
}

fn argMessage(err: anyerror) []const u8 {
    return switch (err) {
        error.InvalidPackage => "Error: that is not a package name (e.g. my-package or @scope/name).",
        error.MessageWithUndo => "Error: --undo takes no message (pantry deprecate <package> --undo).",
        error.MessageTooLong => "Error: the message is longer than 1024 characters.",
        else => "Error: invalid arguments.",
    };
}

fn signInMessage(arena: std.mem.Allocator, url: []const u8) []const u8 {
    return std.fmt.allocPrint(arena,
        \\Error: no credential for {s}.
        \\
        \\Deprecating a package needs its publisher's token:
        \\
        \\  pantry token set --registry {s}
        \\
        \\or set PANTRY_REGISTRY_TOKEN / PANTRY_TOKEN, or pass --token.
    , .{ url, url }) catch "Error: no credential for this registry.";
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

pub fn deprecateCommand(allocator: std.mem.Allocator, opts: Options) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    access.validatePackage(opts.package) catch |err| return CommandResult.err(allocator, argMessage(err));
    validateArgs(opts) catch |err| return CommandResult.err(allocator, argMessage(err));

    const url = registry_ops.resolveRegistryUrl(arena, opts.registry) orelse endpoint.baseUrl();
    const token = registry_ops.credentialFor(arena, opts.token, url) orelse
        return CommandResult.err(allocator, signInMessage(arena, url));
    // httpRequest sets the JSON content type for a body itself.
    const headers = [_]std.http.Header{
        .{ .name = "Authorization", .value = try std.fmt.allocPrint(arena, "Bearer {s}", .{token}) },
    };

    const target = try deprecationUrl(arena, url, opts.package);
    const res = (if (opts.undo)
        io_helper.httpRequest(arena, .DELETE, target, null, &headers)
    else
        io_helper.httpRequest(arena, .PUT, target, try requestBody(arena, opts.message), &headers)) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));

    if (!res.ok()) {
        const what = if (opts.undo) "undeprecate" else "deprecate";
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not {s} {s}: {s}{s}", .{ what, opts.package, registry_ops.apiError(arena, res), failureHint(res.status) }));
    }

    if (opts.undo) {
        return CommandResult.success(allocator, try std.fmt.allocPrint(arena, "{s} is no longer deprecated.", .{opts.package}));
    }
    const message = responseMessage(arena, res.body) orelse std.mem.trim(u8, opts.message orelse "", &std.ascii.whitespace);
    return CommandResult.success(allocator, try std.fmt.allocPrint(arena,
        \\Deprecated {s}: {s}
        \\
        \\Every version still installs; installs now print this as a warning.
        \\Undo with:  pantry deprecate {s} --undo
    , .{ opts.package, message, opts.package }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "deprecate: URL encodes scoped names the way /packages calls do" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try testing.expectEqualStrings("https://registry.pantry.dev/packages/@hq%2Fkit-probe/deprecation", try deprecationUrl(arena, "https://registry.pantry.dev", "@hq/kit-probe"));
    try testing.expectEqualStrings("https://r.test/packages/left-pad/deprecation", try deprecationUrl(arena, "https://r.test", "left-pad"));
}

test "deprecate: request body" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try testing.expectEqualStrings("{}", try requestBody(arena, null));
    try testing.expectEqualStrings("{}", try requestBody(arena, "   "));
    try testing.expectEqualStrings(
        \\{"message":"use @hq/kit, not \"probe\""}
    , try requestBody(arena, " use @hq/kit, not \"probe\" "));
}

test "deprecate: argument validation" {
    try validateArgs(.{ .package = "x" });
    try validateArgs(.{ .package = "x", .message = "gone" });
    try validateArgs(.{ .package = "x", .undo = true });
    try validateArgs(.{ .package = "x", .undo = true, .message = "  " });
    try testing.expectError(error.MessageWithUndo, validateArgs(.{ .package = "x", .undo = true, .message = "gone" }));
    const long: [max_message_len + 1]u8 = @splat('a');
    try testing.expectError(error.MessageTooLong, validateArgs(.{ .package = "x", .message = &long }));
}

test "deprecate: response and failure messages" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try testing.expectEqualStrings("gone", responseMessage(arena,
        \\{"name":"@hq/kit-probe","deprecated":true,"message":"gone"}
    ).?);
    try testing.expect(responseMessage(arena,
        \\{"name":"@hq/kit-probe","deprecated":false}
    ) == null);
    try testing.expect(responseMessage(arena, "not json") == null);
    try testing.expect(std.mem.indexOf(u8, failureHint(401), "publish permission") != null);
    try testing.expect(std.mem.indexOf(u8, failureHint(403), "publisher") != null);
    try testing.expectEqualStrings("", failureHint(500));
}
