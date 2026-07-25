//! Which registry this machine talks to, and how it authenticates to it.
//!
//! Two things a self-hosted registry needs from the client, both of which have
//! to apply to *every* HTTP call the CLI makes rather than to the handful of
//! call sites someone remembers to update:
//!
//!   1. **Where to look.** `PANTRY_REGISTRY_URL=https://registry.example.com`
//!      redirects requests aimed at the default registry to yours. The URLs are
//!      still built as `https://registry.pantry.dev/...` all over the install
//!      path; they are rewritten as the request goes out.
//!
//!   2. **Who is asking.** A private registry serves nothing without a
//!      credential, so requests to your registry carry
//!      `Authorization: Bearer <token>` — the token stored by
//!      `pantry token set --registry https://registry.example.com`, or
//!      `PANTRY_REGISTRY_TOKEN` / `PANTRY_TOKEN` from the environment.
//!
//! Tokens are only ever sent to a registry you have named: either the origin
//! matches `PANTRY_REGISTRY_URL`, or `~/.pantry/credentials` holds an entry
//! scoped to exactly that origin. A stray `PANTRY_TOKEN` in the environment is
//! never broadcast to third-party hosts (npm, GitHub, object storage), and
//! nothing is sent to the public registry unless you asked for it.
//!
//! `io_helper` calls in here through a function pointer (installed in `main`)
//! so the low-level HTTP code doesn't have to know about the credential store.

const std = @import("std");
const io_helper = @import("../io_helper.zig");
const token_commands = @import("../cli/commands/token.zig");

/// The registry used when nothing else is configured.
pub const default_base = "https://registry.pantry.dev";

/// Environment variable naming the registry to talk to.
pub const url_env = "PANTRY_REGISTRY_URL";

const Scoped = struct {
    origin: []const u8,
    token: []const u8,
};

const Resolved = struct {
    /// Configured base URL, trailing slash removed. Null ⇒ the default registry.
    base: ?[]const u8 = null,
    /// `scheme://host[:port]` of `base`.
    base_origin: ?[]const u8 = null,
    /// Credential for `base`, if we have one.
    base_token: ?[]const u8 = null,
    /// Per-origin credentials from `~/.pantry/credentials` sections.
    scoped: []const Scoped = &.{},
};

var resolve_mutex: io_helper.Mutex = .{};
var resolved: ?Resolved = null;

/// Process-lifetime cache. The CLI makes hundreds of requests per install and
/// re-reading the credentials file for each one would be silly; it also means
/// the file is read once, under one lock, rather than from every worker thread.
fn config() Resolved {
    resolve_mutex.lock();
    defer resolve_mutex.unlock();
    if (resolved) |cached| return cached;

    const allocator = std.heap.page_allocator;
    var out = Resolved{};

    if (io_helper.getEnvVarOwned(allocator, url_env)) |raw| {
        const trimmed = std.mem.trimEnd(u8, std.mem.trim(u8, raw, &std.ascii.whitespace), "/");
        if (trimmed.len > 0 and std.mem.indexOf(u8, trimmed, "://") != null) {
            out.base = allocator.dupe(u8, trimmed) catch null;
            if (out.base) |base| {
                out.base_origin = originOf(base);
                if (token_commands.resolve(allocator, null, base, token_commands.default_key)) |maybe| {
                    if (maybe) |token| out.base_token = token.value;
                } else |_| {}
            }
        }
        allocator.free(raw);
    } else |_| {}

    out.scoped = loadScoped(allocator) catch &.{};

    resolved = out;
    return out;
}

/// Credentials explicitly scoped to a registry — `[https://…]` sections in the
/// credentials file. An entry here is a statement of intent: this token belongs
/// to that origin, so it is safe to send there and nowhere else.
fn loadScoped(allocator: std.mem.Allocator) ![]const Scoped {
    var store = token_commands.Store.load(allocator) catch return &.{};
    defer store.deinit();

    var list: std.ArrayList(Scoped) = .empty;
    errdefer list.deinit(allocator);

    for (store.entries.items) |entry| {
        const scope = entry.registry orelse continue;
        if (!std.mem.eql(u8, entry.key, token_commands.default_key)) continue;
        const origin = originOf(std.mem.trimEnd(u8, scope, "/")) orelse continue;
        try list.append(allocator, .{
            .origin = try allocator.dupe(u8, origin),
            .token = try allocator.dupe(u8, entry.value),
        });
    }

    return try list.toOwnedSlice(allocator);
}

/// `https://host:port/path?q` → `https://host:port`. Null when not a URL.
pub fn originOf(url: []const u8) ?[]const u8 {
    const scheme_end = std.mem.indexOf(u8, url, "://") orelse return null;
    const host_start = scheme_end + 3;
    if (host_start >= url.len) return null;
    const end = std.mem.indexOfScalarPos(u8, url, host_start, '/') orelse url.len;
    return url[0..end];
}

fn sameOrigin(a: []const u8, b: []const u8) bool {
    return std.ascii.eqlIgnoreCase(a, b);
}

/// The registry base URL in force: `PANTRY_REGISTRY_URL`, else the default.
pub fn baseUrl() []const u8 {
    return config().base orelse default_base;
}

/// Whether requests are pointed at a registry other than the public one.
pub fn isCustom() bool {
    return config().base != null;
}

/// What to change about an outgoing request: a replacement URL (when this
/// machine points at a registry other than the default) and/or an
/// `Authorization` value (when that registry is private). Defined by the HTTP
/// layer so it can hold the hook without importing this module.
pub const Decoration = io_helper.RequestDecoration;

/// Decide how to send a request to `url`. Never fails: on any error the request
/// goes out exactly as it would have before.
///
/// This is the function installed as `io_helper.decorate_request`.
pub fn decorate(allocator: std.mem.Allocator, url: []const u8) Decoration {
    return decorateWith(allocator, url, config());
}

/// The decision itself, against an explicit configuration. Separated from the
/// cached environment lookup so it can be tested without a HOME directory.
fn decorateWith(allocator: std.mem.Allocator, url: []const u8, cfg: Resolved) Decoration {
    var out = Decoration{};

    // Requests written against the default registry follow the configured one.
    var effective = url;
    if (cfg.base) |base| {
        if (std.mem.startsWith(u8, url, default_base)) {
            const rewritten = std.fmt.allocPrint(allocator, "{s}{s}", .{ base, url[default_base.len..] }) catch return out;
            out.url = rewritten;
            effective = rewritten;
        }
    }

    const origin = originOf(effective) orelse return out;

    // The configured registry: env var, or credentials file, either scope.
    if (cfg.base_origin) |base_origin| {
        if (sameOrigin(origin, base_origin)) {
            if (cfg.base_token) |token| {
                out.authorization = std.fmt.allocPrint(allocator, "Bearer {s}", .{token}) catch null;
                return out;
            }
        }
    }

    // Any origin the user has stored a scoped credential for.
    for (cfg.scoped) |entry| {
        if (sameOrigin(origin, entry.origin)) {
            out.authorization = std.fmt.allocPrint(allocator, "Bearer {s}", .{entry.token}) catch null;
            return out;
        }
    }

    return out;
}

/// Point `io_helper` at this module. Called once from `main`.
pub fn install() void {
    io_helper.decorate_request = &decorate;
}

/// Drop the cache. Tests only — the CLI resolves once and exits.
pub fn resetForTesting() void {
    resolve_mutex.lock();
    defer resolve_mutex.unlock();
    resolved = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test "originOf keeps scheme, host and port, and stops at the path" {
    try std.testing.expectEqualStrings("https://registry.example.com", originOf("https://registry.example.com/packages/x").?);
    try std.testing.expectEqualStrings("https://registry.example.com:8443", originOf("https://registry.example.com:8443/a/b").?);
    try std.testing.expectEqualStrings("http://localhost:3000", originOf("http://localhost:3000").?);
    try std.testing.expect(originOf("not-a-url") == null);
}

test "an unconfigured client sends every request exactly as written" {
    const alloc = std.testing.allocator;
    const cfg = Resolved{};

    // The public registry, npm, GitHub — all untouched, no token anywhere.
    for ([_][]const u8{
        default_base ++ "/binaries/curl.se/metadata.json",
        "https://registry.npmjs.org/left-pad",
        "https://github.com/x/y/releases/download/v1/z.tar.gz",
    }) |url| {
        const dec = decorateWith(alloc, url, cfg);
        defer dec.deinit(alloc);
        try std.testing.expect(dec.isEmpty());
        try std.testing.expectEqualStrings(url, dec.effectiveUrl(url));
    }
}

test "a configured registry receives rewritten, authenticated requests" {
    const alloc = std.testing.allocator;
    const cfg = Resolved{
        .base = "https://registry.example.com",
        .base_origin = "https://registry.example.com",
        .base_token = "ptry_secret",
    };

    const dec = decorateWith(alloc, default_base ++ "/binaries/curl.se/metadata.json", cfg);
    defer dec.deinit(alloc);
    try std.testing.expectEqualStrings("https://registry.example.com/binaries/curl.se/metadata.json", dec.url.?);
    try std.testing.expectEqualStrings("Bearer ptry_secret", dec.authorization.?);
}

test "the token never leaves the registry it belongs to" {
    const alloc = std.testing.allocator;
    const cfg = Resolved{
        .base = "https://registry.example.com",
        .base_origin = "https://registry.example.com",
        .base_token = "ptry_secret",
    };

    // Presigned object-storage redirects, npm, and lookalike hostnames are all
    // third parties as far as the credential is concerned.
    for ([_][]const u8{
        "https://bucket.fsn1.your-objectstorage.com/binaries/curl.se/x.tar.gz",
        "https://registry.npmjs.org/left-pad",
        "https://registry.example.com.attacker.test/binaries/x",
    }) |url| {
        const dec = decorateWith(alloc, url, cfg);
        defer dec.deinit(alloc);
        try std.testing.expect(dec.authorization == null);
    }
}

test "a scoped credential authenticates its own registry only" {
    const alloc = std.testing.allocator;
    const scoped = [_]Scoped{.{ .origin = "https://packages.acme.internal", .token = "ptry_acme" }};
    const cfg = Resolved{ .scoped = &scoped };

    const mine = decorateWith(alloc, "https://packages.acme.internal/packages/sdk/1.0.0/tarball", cfg);
    defer mine.deinit(alloc);
    try std.testing.expectEqualStrings("Bearer ptry_acme", mine.authorization.?);
    // No PANTRY_REGISTRY_URL, so nothing is rewritten.
    try std.testing.expect(mine.url == null);

    const theirs = decorateWith(alloc, default_base ++ "/packages/left-pad", cfg);
    defer theirs.deinit(alloc);
    try std.testing.expect(theirs.isEmpty());
}

test "port and case differences are part of the origin, not ignored" {
    const alloc = std.testing.allocator;
    const cfg = Resolved{
        .base = "http://localhost:3000",
        .base_origin = "http://localhost:3000",
        .base_token = "ptry_local",
    };

    const same = decorateWith(alloc, "http://LOCALHOST:3000/health", cfg);
    defer same.deinit(alloc);
    try std.testing.expectEqualStrings("Bearer ptry_local", same.authorization.?);

    const other_port = decorateWith(alloc, "http://localhost:3001/health", cfg);
    defer other_port.deinit(alloc);
    try std.testing.expect(other_port.authorization == null);
}
