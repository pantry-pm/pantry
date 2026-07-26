//! Build insurance, security alerts and SBOM export.
//!
//!   pantry insure            Mirror everything this project installs
//!   pantry insure list       What's insured
//!   pantry alerts            Vulnerabilities and licence violations
//!   pantry sbom              Write an SBOM (CycloneDX or SPDX)
//!
//! All three work from the project's lockfile: the exact set of things a build
//! actually resolved, rather than the ranges a manifest asks for. What gets
//! insured is what would break.
//!
//! These are paid features, and the registry says so plainly if the account
//! isn't subscribed — the CLI doesn't pretend to know the plan in advance.

const std = @import("std");
const io_helper = @import("../../io_helper.zig");
const style = @import("../style.zig");
const common = @import("common.zig");
const registry_ops = @import("registry_ops.zig");
const endpoint = @import("../../registry/endpoint.zig");

const CommandResult = common.CommandResult;

fn registryUrl(arena: std.mem.Allocator, explicit: ?[]const u8) []const u8 {
    if (registry_ops.resolveRegistryUrl(arena, explicit)) |url| return url;
    return endpoint.baseUrl();
}

fn authHeaders(arena: std.mem.Allocator, token: []const u8) ![]const std.http.Header {
    const value = try std.fmt.allocPrint(arena, "Bearer {s}", .{token});
    const headers = try arena.alloc(std.http.Header, 1);
    headers[0] = .{ .name = "Authorization", .value = value };
    return headers;
}

pub const Options = struct {
    registry: ?[]const u8 = null,
    token: ?[]const u8 = null,
    /// Lockfile to read. Defaults to the usual suspects in the working directory.
    lockfile: ?[]const u8 = null,
    /// `cyclonedx` (default) or `spdx`.
    format: ?[]const u8 = null,
    /// Where to write the SBOM. Defaults to stdout.
    out: ?[]const u8 = null,
    /// Licences to refuse, comma-separated.
    deny: ?[]const u8 = null,
    /// The only licences to accept, comma-separated.
    allow: ?[]const u8 = null,
};

// ---------------------------------------------------------------------------
// Reading what this project installs
// ---------------------------------------------------------------------------

pub const Dependency = struct {
    name: []const u8,
    version: []const u8,
    resolved: ?[]const u8 = null,
    integrity: ?[]const u8 = null,
    ecosystem: []const u8 = "npm",
    license: ?[]const u8 = null,
};

const lockfile_candidates = [_][]const u8{ "pantry.lock", "bun.lock", "package-lock.json" };

fn readLockfile(arena: std.mem.Allocator, explicit: ?[]const u8) !?struct { path: []const u8, content: []const u8 } {
    if (explicit) |path| {
        const content = io_helper.readFileAlloc(arena, path, 32 * 1024 * 1024) catch return null;
        return .{ .path = path, .content = content };
    }
    for (lockfile_candidates) |candidate| {
        if (io_helper.readFileAlloc(arena, candidate, 32 * 1024 * 1024)) |content| {
            return .{ .path = candidate, .content = content };
        } else |_| {}
    }
    return null;
}

/// Pull `name@version` pairs out of an npm-style lockfile.
///
/// `packages` maps `node_modules/<name>` to an object with version/resolved/
/// integrity — the v2/v3 npm and bun format. Anything we can't read is skipped
/// rather than guessed at: a wrong entry in an SBOM is worse than a missing one.
pub fn parseNpmLockfile(arena: std.mem.Allocator, content: []const u8) ![]Dependency {
    var out: std.ArrayList(Dependency) = .empty;

    var parsed = std.json.parseFromSlice(std.json.Value, arena, content, .{ .ignore_unknown_fields = true }) catch
        return out.toOwnedSlice(arena);
    defer parsed.deinit();

    if (parsed.value != .object) return out.toOwnedSlice(arena);
    const packages = parsed.value.object.get("packages") orelse return out.toOwnedSlice(arena);
    if (packages != .object) return out.toOwnedSlice(arena);

    var it = packages.object.iterator();
    while (it.next()) |kv| {
        const key = kv.key_ptr.*;
        // "" is the project itself.
        if (key.len == 0) continue;

        const marker = "node_modules/";
        const idx = std.mem.lastIndexOf(u8, key, marker) orelse continue;
        const name = key[idx + marker.len ..];
        if (name.len == 0) continue;

        const entry = kv.value_ptr.*;
        if (entry != .object) continue;

        const version = blk: {
            const v = entry.object.get("version") orelse continue;
            if (v != .string) continue;
            break :blk v.string;
        };

        try out.append(arena, .{
            .name = try arena.dupe(u8, name),
            .version = try arena.dupe(u8, version),
            .resolved = if (entry.object.get("resolved")) |r| (if (r == .string) try arena.dupe(u8, r.string) else null) else null,
            .integrity = if (entry.object.get("integrity")) |i| (if (i == .string) try arena.dupe(u8, i.string) else null) else null,
            .license = if (entry.object.get("license")) |l| (if (l == .string) try arena.dupe(u8, l.string) else null) else null,
        });
    }

    return out.toOwnedSlice(arena);
}

fn appendEntries(out: *std.ArrayList(u8), arena: std.mem.Allocator, deps: []const Dependency) !void {
    try out.appendSlice(arena, "[");
    for (deps, 0..) |dep, i| {
        if (i > 0) try out.append(arena, ',');
        try out.appendSlice(arena, "{\"name\":");
        try registry_ops.appendJsonString(out, arena, dep.name);
        try out.appendSlice(arena, ",\"version\":");
        try registry_ops.appendJsonString(out, arena, dep.version);
        try out.appendSlice(arena, ",\"ecosystem\":");
        try registry_ops.appendJsonString(out, arena, dep.ecosystem);
        if (dep.resolved) |r| {
            try out.appendSlice(arena, ",\"resolved\":");
            try registry_ops.appendJsonString(out, arena, r);
        }
        if (dep.integrity) |integrity| {
            try out.appendSlice(arena, ",\"integrity\":");
            try registry_ops.appendJsonString(out, arena, integrity);
        }
        if (dep.license) |l| {
            try out.appendSlice(arena, ",\"license\":");
            try registry_ops.appendJsonString(out, arena, l);
        }
        try out.append(arena, '}');
    }
    try out.appendSlice(arena, "]");
}

fn appendLicenseList(out: *std.ArrayList(u8), arena: std.mem.Allocator, csv: []const u8) !void {
    try out.append(arena, '[');
    var it = std.mem.splitScalar(u8, csv, ',');
    var first = true;
    while (it.next()) |raw| {
        const value = std.mem.trim(u8, raw, &std.ascii.whitespace);
        if (value.len == 0) continue;
        if (!first) try out.append(arena, ',');
        try registry_ops.appendJsonString(out, arena, value);
        first = false;
    }
    try out.append(arena, ']');
}

const no_lockfile_message =
    \\Error: no lockfile here.
    \\
    \\This works from the exact set a build resolved, so run it in a project with
    \\a pantry.lock, bun.lock or package-lock.json — or pass --lockfile <path>.
;

fn credential(arena: std.mem.Allocator, opts: Options, url: []const u8) ?[]const u8 {
    return registry_ops.credentialFor(arena, opts.token, url);
}

fn signInMessage(arena: std.mem.Allocator, url: []const u8) []const u8 {
    return std.fmt.allocPrint(arena,
        \\Error: no credential for {s}.
        \\
        \\  pantry token set --registry {s}
    , .{ url, url }) catch "Error: no credential for this registry.";
}

// ---------------------------------------------------------------------------
// pantry insure
// ---------------------------------------------------------------------------

pub fn insureCommand(allocator: std.mem.Allocator, opts: Options) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const token = credential(arena, opts, url) orelse return CommandResult.err(allocator, signInMessage(arena, url));

    const lock = (try readLockfile(arena, opts.lockfile)) orelse
        return CommandResult.err(allocator, no_lockfile_message);
    const deps = try parseNpmLockfile(arena, lock.content);
    if (deps.len == 0)
        return CommandResult.err(allocator, "Nothing to insure — no resolved dependencies found in that lockfile.");

    style.print("Insuring {d} artifact(s) from {s}...\n", .{ deps.len, lock.path });

    var body: std.ArrayList(u8) = .empty;
    try body.appendSlice(arena, "{\"entries\":");
    try appendEntries(&body, arena, deps);
    try body.append(arena, '}');

    const target = try std.fmt.allocPrint(arena, "{s}/mirror/snapshot", .{url});
    const res = io_helper.httpRequest(arena, .POST, target, body.items, try authHeaders(arena, token)) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));

    if (!res.ok())
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not insure this build: {s}", .{registry_ops.apiError(arena, res)}));

    var parsed = std.json.parseFromSlice(std.json.Value, arena, res.body, .{ .ignore_unknown_fields = true }) catch
        return CommandResult.success(allocator, "Insured.");
    defer parsed.deinit();

    const mirrored = jsonInt(parsed.value, "mirrored");
    const skipped = jsonInt(parsed.value, "skipped");
    const failed = jsonInt(parsed.value, "failed");

    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, try std.fmt.allocPrint(arena,
        "{d} newly stored, {d} already insured, {d} could not be fetched.\n", .{ mirrored, skipped, failed }));

    if (failed > 0) {
        if (parsed.value == .object) {
            if (parsed.value.object.get("failures")) |failures| {
                if (failures == .array) {
                    try out.appendSlice(arena, "\nNot insured:\n");
                    for (failures.array.items) |f| {
                        const name = jsonStr(f, "name") orelse continue;
                        const version = jsonStr(f, "version") orelse "";
                        const err = jsonStr(f, "error") orelse "unknown";
                        try out.appendSlice(arena, try std.fmt.allocPrint(arena, "  {s}@{s} — {s}\n", .{ name, version, err }));
                    }
                }
            }
        }
    }

    try out.appendSlice(arena, "\nIf one of these disappears upstream, your build still resolves.\n");
    return CommandResult.success(allocator, out.items);
}

pub fn insureListCommand(allocator: std.mem.Allocator, opts: Options) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const token = credential(arena, opts, url) orelse return CommandResult.err(allocator, signInMessage(arena, url));

    const target = try std.fmt.allocPrint(arena, "{s}/mirror", .{url});
    const res = io_helper.httpRequest(arena, .GET, target, null, try authHeaders(arena, token)) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));
    if (!res.ok())
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not read your mirror: {s}", .{registry_ops.apiError(arena, res)}));

    var parsed = std.json.parseFromSlice(std.json.Value, arena, res.body, .{ .ignore_unknown_fields = true }) catch
        return CommandResult.err(allocator, "The registry returned a response this version doesn't understand.");
    defer parsed.deinit();

    const stats = if (parsed.value == .object) parsed.value.object.get("stats") else null;
    const stored = if (stats) |st| jsonInt(st, "stored") else 0;
    const bytes = if (stats) |st| jsonInt(st, "bytes") else 0;
    const failed = if (stats) |st| jsonInt(st, "failed") else 0;

    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, try std.fmt.allocPrint(arena,
        "{d} artifact(s) insured, {d} MB stored{s}\n\n", .{
            stored,
            @divTrunc(bytes, 1024 * 1024),
            if (failed > 0) " (some could not be fetched)" else "",
        }));

    if (parsed.value == .object) {
        if (parsed.value.object.get("entries")) |entries| {
            if (entries == .array) {
                for (entries.array.items[0..@min(entries.array.items.len, 40)]) |e| {
                    const name = jsonStr(e, "name") orelse continue;
                    const version = jsonStr(e, "version") orelse "";
                    const err = jsonStr(e, "error");
                    if (err) |message| {
                        try out.appendSlice(arena, try std.fmt.allocPrint(arena, "  {s}@{s} — not stored: {s}\n", .{ name, version, message }));
                    } else {
                        try out.appendSlice(arena, try std.fmt.allocPrint(arena, "  {s}@{s}\n", .{ name, version }));
                    }
                }
            }
        }
    }

    return CommandResult.success(allocator, out.items);
}

// ---------------------------------------------------------------------------
// pantry alerts
// ---------------------------------------------------------------------------

pub fn alertsCommand(allocator: std.mem.Allocator, opts: Options) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const token = credential(arena, opts, url) orelse return CommandResult.err(allocator, signInMessage(arena, url));

    // Registering is idempotent, so `pantry alerts` in a project both refreshes
    // what's watched and reports on it — one command, no setup step.
    if (try readLockfile(arena, opts.lockfile)) |lock| {
        const deps = try parseNpmLockfile(arena, lock.content);
        if (deps.len > 0) {
            var body: std.ArrayList(u8) = .empty;
            try body.appendSlice(arena, "{\"entries\":");
            try appendEntries(&body, arena, deps);
            if (opts.deny) |deny| {
                try body.appendSlice(arena, ",\"policy\":{\"deny\":");
                try appendLicenseList(&body, arena, deny);
                try body.append(arena, '}');
            } else if (opts.allow) |allow| {
                try body.appendSlice(arena, ",\"policy\":{\"allow\":");
                try appendLicenseList(&body, arena, allow);
                try body.append(arena, '}');
            }
            try body.append(arena, '}');

            const watch_url = try std.fmt.allocPrint(arena, "{s}/security/watch", .{url});
            const watch_res = io_helper.httpRequest(arena, .PUT, watch_url, body.items, try authHeaders(arena, token)) catch null;
            if (watch_res) |r| {
                if (!r.ok())
                    return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not register your lockfile: {s}", .{registry_ops.apiError(arena, r)}));
            }
        }
    }

    const target = try std.fmt.allocPrint(arena, "{s}/security/alerts", .{url});
    const res = io_helper.httpRequest(arena, .GET, target, null, try authHeaders(arena, token)) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));
    if (!res.ok())
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not read alerts: {s}", .{registry_ops.apiError(arena, res)}));

    var parsed = std.json.parseFromSlice(std.json.Value, arena, res.body, .{ .ignore_unknown_fields = true }) catch
        return CommandResult.err(allocator, "The registry returned a response this version doesn't understand.");
    defer parsed.deinit();

    var out: std.ArrayList(u8) = .empty;
    const watched = jsonInt(parsed.value, "watched");

    // A degraded report means we could not check — never let that read as clean.
    if (jsonStr(parsed.value, "degraded")) |why| {
        try out.appendSlice(arena, try std.fmt.allocPrint(arena,
            "WARNING: the advisory database could not be reached ({s}).\nThis is NOT an all-clear.\n\n", .{why}));
    }

    const alerts = if (parsed.value == .object) parsed.value.object.get("alerts") else null;
    const count = if (alerts != null and alerts.? == .array) alerts.?.array.items.len else 0;

    if (count == 0) {
        try out.appendSlice(arena, try std.fmt.allocPrint(arena, "Nothing outstanding across {d} watched artifact(s).\n", .{watched}));
        return CommandResult.success(allocator, out.items);
    }

    try out.appendSlice(arena, try std.fmt.allocPrint(arena, "{d} finding(s) across {d} watched artifact(s):\n\n", .{ count, watched }));

    for (alerts.?.array.items) |alert| {
        const kind = jsonStr(alert, "type") orelse continue;
        const name = jsonStr(alert, "package") orelse continue;
        const version = jsonStr(alert, "version") orelse "";

        if (std.mem.eql(u8, kind, "vulnerability")) {
            const severity = jsonStr(alert, "severity") orelse "unknown";
            const id = jsonStr(alert, "id") orelse "";
            const summary = jsonStr(alert, "summary") orelse "";
            try out.appendSlice(arena, try std.fmt.allocPrint(arena, "  [{s}] {s}@{s} — {s}\n    {s}\n", .{ severity, name, version, id, summary }));
            if (jsonStr(alert, "fixedIn")) |fixed| {
                try out.appendSlice(arena, try std.fmt.allocPrint(arena, "    fixed in {s}\n", .{fixed}));
            }
        } else {
            const summary = jsonStr(alert, "summary") orelse "";
            try out.appendSlice(arena, try std.fmt.allocPrint(arena, "  [licence] {s}\n", .{summary}));
        }
    }

    // Findings are an exit-code-1 condition so CI can gate on it.
    var result = try CommandResult.success(allocator, out.items);
    result.exit_code = 1;
    return result;
}

// ---------------------------------------------------------------------------
// pantry sbom
// ---------------------------------------------------------------------------

pub fn sbomCommand(allocator: std.mem.Allocator, opts: Options) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const token = credential(arena, opts, url) orelse return CommandResult.err(allocator, signInMessage(arena, url));

    const format = opts.format orelse "cyclonedx";
    const target = try std.fmt.allocPrint(arena, "{s}/sbom?format={s}", .{ url, format });
    const res = io_helper.httpRequest(arena, .GET, target, null, try authHeaders(arena, token)) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));
    if (!res.ok())
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not export an SBOM: {s}", .{registry_ops.apiError(arena, res)}));

    if (opts.out) |path| {
        const file = io_helper.createFile(path, .{}) catch
            return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not write {s}.", .{path}));
        defer io_helper.closeFile(file);
        io_helper.writeAllToFile(file, res.body) catch
            return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not write {s}.", .{path}));
        return CommandResult.success(allocator, try std.fmt.allocPrint(arena, "Wrote {s} ({s}, {d} bytes).", .{ path, format, res.body.len }));
    }

    style.print("{s}\n", .{res.body});
    return CommandResult.success(allocator, null);
}

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

fn jsonStr(value: std.json.Value, key: []const u8) ?[]const u8 {
    if (value != .object) return null;
    const found = value.object.get(key) orelse return null;
    return if (found == .string) found.string else null;
}

fn jsonInt(value: std.json.Value, key: []const u8) i64 {
    if (value != .object) return 0;
    const found = value.object.get(key) orelse return 0;
    return if (found == .integer) found.integer else 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test "an npm-style lockfile yields the resolved set" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const lockfile =
        \\{
        \\  "lockfileVersion": 3,
        \\  "packages": {
        \\    "": { "name": "my-app", "version": "1.0.0" },
        \\    "node_modules/left-pad": {
        \\      "version": "1.3.0",
        \\      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
        \\      "integrity": "sha512-abc",
        \\      "license": "WTFPL"
        \\    },
        \\    "node_modules/@acme/sdk": { "version": "2.0.0" }
        \\  }
        \\}
    ;

    const deps = try parseNpmLockfile(arena, lockfile);
    try std.testing.expectEqual(@as(usize, 2), deps.len);

    var found_left_pad = false;
    for (deps) |dep| {
        if (std.mem.eql(u8, dep.name, "left-pad")) {
            found_left_pad = true;
            try std.testing.expectEqualStrings("1.3.0", dep.version);
            try std.testing.expectEqualStrings("sha512-abc", dep.integrity.?);
            try std.testing.expectEqualStrings("WTFPL", dep.license.?);
        }
    }
    try std.testing.expect(found_left_pad);
}

test "the project itself is not a dependency of itself" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const deps = try parseNpmLockfile(arena,
        \\{"packages": {"": {"name": "my-app", "version": "1.0.0"}}}
    );
    try std.testing.expectEqual(@as(usize, 0), deps.len);
}

test "an unreadable lockfile yields nothing rather than nonsense" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try std.testing.expectEqual(@as(usize, 0), (try parseNpmLockfile(arena, "not json at all")).len);
    try std.testing.expectEqual(@as(usize, 0), (try parseNpmLockfile(arena, "{}")).len);
    // An entry with no version is skipped, not emitted with a blank one.
    try std.testing.expectEqual(@as(usize, 0), (try parseNpmLockfile(arena,
        \\{"packages": {"node_modules/broken": {"resolved": "https://x"}}}
    )).len);
}

test "entries serialize as the API expects" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var out: std.ArrayList(u8) = .empty;
    try appendEntries(&out, arena, &.{
        .{ .name = "left-pad", .version = "1.3.0", .resolved = "https://x/lp.tgz", .integrity = "sha512-a\"b" },
    });

    try std.testing.expectEqualStrings(
        "[{\"name\":\"left-pad\",\"version\":\"1.3.0\",\"ecosystem\":\"npm\",\"resolved\":\"https://x/lp.tgz\",\"integrity\":\"sha512-a\\\"b\"}]",
        out.items,
    );
}

test "a licence list becomes a JSON array" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var out: std.ArrayList(u8) = .empty;
    try appendLicenseList(&out, arena, "AGPL-3.0, GPL-3.0 ,, SSPL-1.0");
    try std.testing.expectEqualStrings("[\"AGPL-3.0\",\"GPL-3.0\",\"SSPL-1.0\"]", out.items);
}
