//! Token Commands
//!
//! Manage the credentials `pantry` uses to authenticate against registries.
//!
//! - `pantry token set [KEY]`   Store a credential (optionally per registry)
//! - `pantry token get [KEY]`   Print a credential, for piping into other tools
//! - `pantry token list`        Show what's configured, masked, and where from
//! - `pantry token rm [KEY]`    Remove a credential
//! - `pantry token sync [KEY]`  Copy a credential into a repo's CI secrets
//!
//! Credentials live in `~/.pantry/credentials`, which publishing already read
//! but nothing could write — the only way in was to hand-edit the file.
//!
//! The file is `KEY=value` lines, with optional `[registry-url]` sections:
//!
//!     PANTRY_TOKEN=ptry_default
//!
//!     [https://registry.pantry.dev]
//!     PANTRY_TOKEN=ptry_scoped
//!
//! Keys before any section apply to every registry, so the flat files written
//! before sections existed keep working unchanged. A scoped entry wins over a
//! global one, which is what lets a private registry and the public one hold
//! different tokens.

const std = @import("std");
const builtin = @import("builtin");
const lib = @import("../../lib.zig");
const io_helper = @import("../../io_helper.zig");
const style = @import("../style.zig");
const common = @import("common.zig");
const CommandResult = common.CommandResult;

/// Credential key used when the caller doesn't name one.
pub const default_key = "PANTRY_TOKEN";

/// Environment variables consulted before the credentials file, in order.
/// Both names are accepted because the registry server, the GitHub action and
/// this CLI have each historically used one or the other.
pub const env_names = [_][]const u8{ "PANTRY_REGISTRY_TOKEN", "PANTRY_TOKEN" };

/// Where a resolved credential came from — surfaced by `token list` and by
/// publish errors, so "no authentication found" can say what it looked at.
pub const Source = enum {
    flag,
    env,
    file_scoped,
    file_global,

    pub fn label(self: Source) []const u8 {
        return switch (self) {
            .flag => "--token",
            .env => "environment",
            .file_scoped => "credentials (registry)",
            .file_global => "credentials (global)",
        };
    }
};

pub const ResolvedToken = struct {
    value: []const u8,
    source: Source,
    /// Environment variable or registry the value came from, when meaningful.
    detail: ?[]const u8 = null,
    owned: bool,

    pub fn deinit(self: *const ResolvedToken, allocator: std.mem.Allocator) void {
        if (self.owned) allocator.free(self.value);
    }
};

pub const Entry = struct {
    /// Registry this credential is scoped to; null applies to every registry.
    registry: ?[]const u8,
    key: []const u8,
    value: []const u8,
};

/// Normalize a registry URL for comparison: trailing slashes and case are not
/// meaningful in the host, and every real difference survives.
pub fn normalizeRegistry(allocator: std.mem.Allocator, url: []const u8) ![]const u8 {
    const trimmed = std.mem.trim(u8, url, &std.ascii.whitespace);
    const without_slash = std.mem.trimEnd(u8, trimmed, "/");
    const out = try allocator.alloc(u8, without_slash.len);
    for (without_slash, 0..) |c, i| out[i] = std.ascii.toLower(c);
    return out;
}

fn registriesEqual(a: []const u8, b: []const u8) bool {
    const a_trimmed = std.mem.trimEnd(u8, std.mem.trim(u8, a, &std.ascii.whitespace), "/");
    const b_trimmed = std.mem.trimEnd(u8, std.mem.trim(u8, b, &std.ascii.whitespace), "/");
    return std.ascii.eqlIgnoreCase(a_trimmed, b_trimmed);
}

/// The parsed contents of `~/.pantry/credentials`.
pub const Store = struct {
    allocator: std.mem.Allocator,
    entries: std.ArrayList(Entry),
    path: []const u8,

    pub fn deinit(self: *Store) void {
        for (self.entries.items) |entry| {
            if (entry.registry) |r| self.allocator.free(r);
            self.allocator.free(entry.key);
            self.allocator.free(entry.value);
        }
        self.entries.deinit(self.allocator);
        self.allocator.free(self.path);
    }

    /// Path to the credentials file, whether or not it exists yet.
    pub fn defaultPath(allocator: std.mem.Allocator) ![]const u8 {
        const home = try lib.Paths.home(allocator);
        defer allocator.free(home);
        return try std.fmt.allocPrint(allocator, "{s}/.pantry/credentials", .{home});
    }

    /// Load the credentials file. A missing file is an empty store, not an
    /// error — `token set` is expected to be the thing that creates it.
    pub fn load(allocator: std.mem.Allocator) !Store {
        const path = try defaultPath(allocator);
        return loadFrom(allocator, path);
    }

    /// Load from an explicit path, taking ownership of `path`.
    pub fn loadFrom(allocator: std.mem.Allocator, path: []const u8) !Store {
        var store = Store{
            .allocator = allocator,
            .entries = .empty,
            .path = path,
        };
        errdefer store.deinit();

        const content = io_helper.readFileAllocAbsolute(allocator, path, 1024 * 1024) catch |err| switch (err) {
            error.FileNotFound => return store,
            else => return err,
        };
        defer allocator.free(content);

        var section: ?[]const u8 = null;
        defer if (section) |s| allocator.free(s);

        var lines = std.mem.splitScalar(u8, content, '\n');
        while (lines.next()) |raw| {
            const line = std.mem.trim(u8, raw, &std.ascii.whitespace);
            if (line.len == 0 or line[0] == '#' or line[0] == ';') continue;

            if (line[0] == '[' and line[line.len - 1] == ']') {
                if (section) |s| allocator.free(s);
                section = try allocator.dupe(u8, std.mem.trim(u8, line[1 .. line.len - 1], &std.ascii.whitespace));
                continue;
            }

            const eq = std.mem.indexOfScalar(u8, line, '=') orelse continue;
            const key = std.mem.trim(u8, line[0..eq], &std.ascii.whitespace);
            const value = std.mem.trim(u8, line[eq + 1 ..], &std.ascii.whitespace);
            if (key.len == 0) continue;

            try store.entries.append(allocator, .{
                .registry = if (section) |s| try allocator.dupe(u8, s) else null,
                .key = try allocator.dupe(u8, key),
                .value = try allocator.dupe(u8, value),
            });
        }

        return store;
    }

    /// Look up `key`, preferring an entry scoped to `registry` over a global one.
    pub fn get(self: *const Store, key: []const u8, registry: ?[]const u8) ?Entry {
        if (registry) |want| {
            for (self.entries.items) |entry| {
                const scope = entry.registry orelse continue;
                if (std.mem.eql(u8, entry.key, key) and registriesEqual(scope, want)) return entry;
            }
        }
        for (self.entries.items) |entry| {
            if (entry.registry != null) continue;
            if (std.mem.eql(u8, entry.key, key)) return entry;
        }
        return null;
    }

    /// Add or replace a credential.
    pub fn set(self: *Store, key: []const u8, registry: ?[]const u8, value: []const u8) !void {
        for (self.entries.items) |*entry| {
            const same_scope = blk: {
                if (entry.registry == null and registry == null) break :blk true;
                if (entry.registry) |a| {
                    if (registry) |b| break :blk registriesEqual(a, b);
                }
                break :blk false;
            };
            if (same_scope and std.mem.eql(u8, entry.key, key)) {
                const new_value = try self.allocator.dupe(u8, value);
                self.allocator.free(entry.value);
                entry.value = new_value;
                return;
            }
        }

        try self.entries.append(self.allocator, .{
            .registry = if (registry) |r| try self.allocator.dupe(u8, r) else null,
            .key = try self.allocator.dupe(u8, key),
            .value = try self.allocator.dupe(u8, value),
        });
    }

    /// Remove a credential. Returns whether anything matched.
    pub fn remove(self: *Store, key: []const u8, registry: ?[]const u8) bool {
        var i: usize = 0;
        while (i < self.entries.items.len) : (i += 1) {
            const entry = self.entries.items[i];
            const same_scope = blk: {
                if (entry.registry == null and registry == null) break :blk true;
                if (entry.registry) |a| {
                    if (registry) |b| break :blk registriesEqual(a, b);
                }
                break :blk false;
            };
            if (same_scope and std.mem.eql(u8, entry.key, key)) {
                if (entry.registry) |r| self.allocator.free(r);
                self.allocator.free(entry.key);
                self.allocator.free(entry.value);
                _ = self.entries.orderedRemove(i);
                return true;
            }
        }
        return false;
    }

    /// Write the file back out, owner-readable only.
    ///
    /// Written to a temp file and renamed so a failed write can't truncate the
    /// credentials that were already there. Comments and blank lines are not
    /// preserved — the file is managed by these commands.
    pub fn save(self: *const Store) !void {
        const dir = std.fs.path.dirname(self.path) orelse return error.InvalidPath;
        // Already-exists is the common case and not an error here.
        io_helper.makePath(dir) catch {};

        var buf: std.ArrayList(u8) = .empty;
        defer buf.deinit(self.allocator);

        try buf.appendSlice(self.allocator, "# Managed by `pantry token`. Values are secrets — keep this file private.\n");

        for (self.entries.items) |entry| {
            if (entry.registry != null) continue;
            try appendLine(&buf, self.allocator, entry.key, entry.value);
        }

        // Group the scoped entries under one header per registry.
        var written: std.ArrayList([]const u8) = .empty;
        defer written.deinit(self.allocator);
        for (self.entries.items) |entry| {
            const scope = entry.registry orelse continue;
            var seen = false;
            for (written.items) |done| {
                if (registriesEqual(done, scope)) {
                    seen = true;
                    break;
                }
            }
            if (seen) continue;
            try written.append(self.allocator, scope);

            try buf.appendSlice(self.allocator, "\n[");
            try buf.appendSlice(self.allocator, scope);
            try buf.appendSlice(self.allocator, "]\n");
            for (self.entries.items) |inner| {
                const inner_scope = inner.registry orelse continue;
                if (!registriesEqual(inner_scope, scope)) continue;
                try appendLine(&buf, self.allocator, inner.key, inner.value);
            }
        }

        const tmp_path = try std.fmt.allocPrint(self.allocator, "{s}.tmp", .{self.path});
        defer self.allocator.free(tmp_path);

        {
            const file = try io_helper.createFileAbsolute(tmp_path, .{});
            defer io_helper.closeFile(file);
            try io_helper.writeAllToFile(file, buf.items);
        }
        errdefer io_helper.deleteFile(tmp_path) catch {};

        try restrictPermissions(tmp_path);
        try io_helper.rename(tmp_path, self.path);
    }
};

fn appendLine(
    buf: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    key: []const u8,
    value: []const u8,
) !void {
    try buf.appendSlice(allocator, key);
    try buf.append(allocator, '=');
    try buf.appendSlice(allocator, value);
    try buf.append(allocator, '\n');
}

/// chmod 600. Credentials are readable by their owner and nobody else; on
/// Windows the filesystem ACL inherited from the user profile is the guard.
fn restrictPermissions(path: []const u8) !void {
    if (comptime builtin.os.tag == .windows) return;
    var path_buf: [std.fs.max_path_bytes:0]u8 = undefined;
    if (path.len >= path_buf.len) return error.NameTooLong;
    @memcpy(path_buf[0..path.len], path);
    path_buf[path.len] = 0;
    const rc = std.c.chmod(@ptrCast(&path_buf), 0o600);
    if (rc != 0) return error.ChmodFailed;
}

/// Resolve the credential to authenticate with, in precedence order:
/// explicit flag, environment, registry-scoped file entry, global file entry.
///
/// Callers own the result and must `deinit` it.
pub fn resolve(
    allocator: std.mem.Allocator,
    explicit: ?[]const u8,
    registry: ?[]const u8,
    key: []const u8,
) !?ResolvedToken {
    if (explicit) |value| {
        if (value.len > 0) {
            return ResolvedToken{ .value = value, .source = .flag, .owned = false };
        }
    }

    // Only the canonical token key is expected in the environment; a caller
    // asking for some other credential (an npm token, say) has its own names.
    if (std.mem.eql(u8, key, default_key)) {
        for (env_names) |name| {
            if (io_helper.getEnvVarOwned(allocator, name)) |value| {
                if (value.len > 0) {
                    return ResolvedToken{ .value = value, .source = .env, .detail = name, .owned = true };
                }
                allocator.free(value);
            } else |_| {}
        }
    }

    var store = Store.load(allocator) catch return null;
    defer store.deinit();

    if (store.get(key, registry)) |entry| {
        return ResolvedToken{
            .value = try allocator.dupe(u8, entry.value),
            .source = if (entry.registry != null) .file_scoped else .file_global,
            .detail = null,
            .owned = true,
        };
    }

    return null;
}

/// Show enough of a secret to recognise it, never enough to use it.
pub fn mask(allocator: std.mem.Allocator, value: []const u8) ![]const u8 {
    if (value.len <= 8) return try allocator.dupe(u8, "********");
    return try std.fmt.allocPrint(allocator, "{s}...{s}", .{ value[0..4], value[value.len - 4 ..] });
}

// ============================================================================
// Commands
// ============================================================================

pub const SetOptions = struct {
    key: []const u8 = default_key,
    registry: ?[]const u8 = null,
    value: ?[]const u8 = null,
    /// Read the value from stdin rather than an argument, so it never lands in
    /// shell history or the process table.
    from_stdin: bool = false,
};

pub fn setCommand(allocator: std.mem.Allocator, options: SetOptions) !CommandResult {
    var value_owned: ?[]const u8 = null;
    defer if (value_owned) |v| allocator.free(v);

    const value: []const u8 = blk: {
        if (options.value) |v| break :blk v;
        const stdin_is_tty = io_helper.File.stdin().isTty(io_helper.io) catch false;
        if (options.from_stdin or !stdin_is_tty) {
            const read = try readSecretFromStdin(allocator);
            value_owned = read;
            break :blk read;
        }
        return CommandResult.err(
            allocator,
            \\Error: No value given.
            \\
            \\Pass --value, or pipe the secret in so it stays out of your shell history:
            \\  pantry token set < token.txt
            \\  op read op://vault/pantry/token | pantry token set
            ,
        );
    };

    if (value.len == 0) {
        return CommandResult.err(allocator, "Error: Refusing to store an empty value.");
    }

    var store = try Store.load(allocator);
    defer store.deinit();

    try store.set(options.key, options.registry, value);
    try store.save();

    if (options.registry) |registry| {
        style.print("Stored {s} for {s} in {s}\n", .{ options.key, registry, store.path });
    } else {
        style.print("Stored {s} in {s}\n", .{ options.key, store.path });
    }
    return .{ .exit_code = 0 };
}

/// Read a secret from stdin, trimming the trailing newline a pipe leaves behind.
fn readSecretFromStdin(allocator: std.mem.Allocator) ![]const u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);

    var chunk: [4096]u8 = undefined;
    while (true) {
        const n = io_helper.readStdin(&chunk) catch break;
        if (n == 0) break;
        try buf.appendSlice(allocator, chunk[0..n]);
        if (buf.items.len > 1024 * 1024) break;
    }

    const trimmed = std.mem.trim(u8, buf.items, &std.ascii.whitespace);
    const out = try allocator.dupe(u8, trimmed);
    buf.deinit(allocator);
    return out;
}

pub const LookupOptions = struct {
    key: []const u8 = default_key,
    registry: ?[]const u8 = null,
};

/// Print the raw value to stdout with no trailing newline, so it pipes cleanly:
///   pantry token get | gh secret set PANTRY_TOKEN --repo owner/repo
pub fn getCommand(allocator: std.mem.Allocator, options: LookupOptions) !CommandResult {
    const resolved = try resolve(allocator, null, options.registry, options.key);
    if (resolved) |token| {
        defer token.deinit(allocator);
        // Straight to stdout, bypassing the styled printer: no newline, no
        // colour, no quiet-mode suppression — the caller is piping this.
        try io_helper.writeAllToFile(io_helper.File.stdout(), token.value);
        return .{ .exit_code = 0 };
    }

    const message = try std.fmt.allocPrint(
        allocator,
        "Error: No {s} found. Set one with `pantry token set`.",
        .{options.key},
    );
    defer allocator.free(message);
    return CommandResult.err(allocator, message);
}

pub fn listCommand(allocator: std.mem.Allocator) !CommandResult {
    var store = try Store.load(allocator);
    defer store.deinit();

    var found_any = false;

    // Environment first: it wins over the file, so showing it first matches
    // what publishing will actually use.
    for (env_names) |name| {
        if (io_helper.getEnvVarOwned(allocator, name)) |value| {
            defer allocator.free(value);
            if (value.len == 0) continue;
            const masked = try mask(allocator, value);
            defer allocator.free(masked);
            if (!found_any) style.print("Credentials:\n", .{});
            found_any = true;
            style.print("  {s}{s}{s}  {s}  {s}(environment){s}\n", .{
                style.cyan, name,      style.reset,
                masked,     style.dim, style.reset,
            });
        } else |_| {}
    }

    for (store.entries.items) |entry| {
        const masked = try mask(allocator, entry.value);
        defer allocator.free(masked);
        if (!found_any) style.print("Credentials:\n", .{});
        found_any = true;
        if (entry.registry) |registry| {
            style.print("  {s}{s}{s}  {s}  {s}({s}){s}\n", .{
                style.cyan,  entry.key, style.reset,
                masked,      style.dim, registry,
                style.reset,
            });
        } else {
            style.print("  {s}{s}{s}  {s}  {s}(all registries){s}\n", .{
                style.cyan, entry.key, style.reset,
                masked,     style.dim, style.reset,
            });
        }
    }

    if (!found_any) {
        style.print("No credentials configured.\n\n", .{});
        style.print("Store one with:\n", .{});
        style.print("  pantry token set          {s}# reads the value from stdin{s}\n", .{ style.dim, style.reset });
        return .{ .exit_code = 0 };
    }

    style.print("\n{s}File: {s}{s}\n", .{ style.dim, store.path, style.reset });
    return .{ .exit_code = 0 };
}

pub fn removeCommand(allocator: std.mem.Allocator, options: LookupOptions) !CommandResult {
    var store = try Store.load(allocator);
    defer store.deinit();

    if (!store.remove(options.key, options.registry)) {
        const message = try std.fmt.allocPrint(
            allocator,
            "Error: No {s} stored{s}{s}.",
            .{
                options.key,
                if (options.registry != null) " for " else "",
                options.registry orelse "",
            },
        );
        defer allocator.free(message);
        return CommandResult.err(allocator, message);
    }

    try store.save();
    style.print("Removed {s}\n", .{options.key});
    return .{ .exit_code = 0 };
}

pub const SyncOptions = struct {
    key: []const u8 = default_key,
    registry: ?[]const u8 = null,
    repo: []const u8,
    /// Secret name on the repo; defaults to the credential's key.
    secret: ?[]const u8 = null,
};

/// Copy a stored credential into a GitHub repository's Actions secrets, so CI
/// can publish with the same token you publish with locally.
///
/// Shells out to `gh` rather than reimplementing the libsodium sealed-box
/// encryption the secrets API requires, and hands the value over on stdin so it
/// never appears in the process table.
pub fn syncCommand(allocator: std.mem.Allocator, options: SyncOptions) !CommandResult {
    if (std.mem.indexOfScalar(u8, options.repo, '/') == null) {
        return CommandResult.err(allocator, "Error: --repo must be in owner/name form (e.g. pantry-pm/pantry).");
    }

    const gh_path = io_helper.findExecutable(allocator, "gh") catch null;
    defer if (gh_path) |p| allocator.free(p);
    if (gh_path == null) {
        return CommandResult.err(
            allocator,
            \\Error: `gh` was not found on PATH.
            \\
            \\The GitHub CLI encrypts the secret before upload, so it's required here.
            \\Install it from https://cli.github.com, or pipe the value yourself:
            \\  pantry token get | gh secret set PANTRY_TOKEN --repo owner/name
            ,
        );
    }

    const resolved = try resolve(allocator, null, options.registry, options.key);
    if (resolved == null) {
        const message = try std.fmt.allocPrint(
            allocator,
            "Error: No {s} found to sync. Set one with `pantry token set`.",
            .{options.key},
        );
        defer allocator.free(message);
        return CommandResult.err(allocator, message);
    }
    const token = resolved.?;
    defer token.deinit(allocator);

    const secret_name = options.secret orelse options.key;

    const argv = [_][]const u8{ gh_path.?, "secret", "set", secret_name, "--repo", options.repo };
    var child = try io_helper.spawn(.{
        .argv = &argv,
        .stdin = .pipe,
    });

    // Hand the secret over on stdin — passing it as an argument would expose it
    // in the process table to every other user on the machine.
    if (child.stdin) |stdin| {
        try io_helper.writeAllToFile(stdin, token.value);
        io_helper.closeFile(stdin);
        child.stdin = null;
    }

    const term = try io_helper.wait(&child);
    switch (term) {
        .exited => |code| {
            if (code != 0) {
                const message = try std.fmt.allocPrint(
                    allocator,
                    "Error: `gh secret set` failed (exit {d}).",
                    .{code},
                );
                defer allocator.free(message);
                return CommandResult.err(allocator, message);
            }
        },
        else => return CommandResult.err(allocator, "Error: `gh secret set` was terminated."),
    }

    style.print("Synced {s} to {s} ({s})\n", .{ secret_name, options.repo, token.source.label() });
    return .{ .exit_code = 0 };
}

// ============================================================================
// Tests
// ============================================================================

const testing = std.testing;

fn tempStore(allocator: std.mem.Allocator, name: []const u8) !Store {
    const path = try std.fmt.allocPrint(allocator, "/tmp/pantry-token-test-{s}", .{name});
    io_helper.deleteFile(path) catch {};
    return Store.loadFrom(allocator, path);
}

test "store round-trips global and scoped credentials" {
    const allocator = testing.allocator;
    var store = try tempStore(allocator, "roundtrip");
    defer {
        io_helper.deleteFile(store.path) catch {};
        store.deinit();
    }

    try store.set(default_key, null, "ptry_global");
    try store.set(default_key, "https://registry.pantry.dev", "ptry_scoped");
    try store.save();

    var reloaded = try Store.loadFrom(allocator, try allocator.dupe(u8, store.path));
    defer reloaded.deinit();

    try testing.expectEqualStrings("ptry_scoped", reloaded.get(default_key, "https://registry.pantry.dev").?.value);
    try testing.expectEqualStrings("ptry_global", reloaded.get(default_key, "https://other.example").?.value);
    try testing.expectEqualStrings("ptry_global", reloaded.get(default_key, null).?.value);
}

test "scoped lookup ignores trailing slash and case" {
    const allocator = testing.allocator;
    var store = try tempStore(allocator, "normalize");
    defer {
        io_helper.deleteFile(store.path) catch {};
        store.deinit();
    }

    try store.set(default_key, "https://Registry.Pantry.Dev/", "ptry_scoped");

    try testing.expectEqualStrings("ptry_scoped", store.get(default_key, "https://registry.pantry.dev").?.value);
    try testing.expectEqualStrings("ptry_scoped", store.get(default_key, "https://registry.pantry.dev/").?.value);
}

test "flat files written before sections existed still load" {
    const allocator = testing.allocator;
    const path = try std.fmt.allocPrint(allocator, "/tmp/pantry-token-test-legacy", .{});
    {
        const file = try io_helper.createFileAbsolute(path, .{});
        defer io_helper.closeFile(file);
        try io_helper.writeAllToFile(file, "# comment\nPANTRY_TOKEN=ptry_legacy\nNPM_TOKEN=npm_legacy\n");
    }
    defer io_helper.deleteFile(path) catch {};

    var store = try Store.loadFrom(allocator, path);
    defer store.deinit();

    try testing.expectEqualStrings("ptry_legacy", store.get(default_key, null).?.value);
    try testing.expectEqualStrings("ptry_legacy", store.get(default_key, "https://registry.pantry.dev").?.value);
    try testing.expectEqualStrings("npm_legacy", store.get("NPM_TOKEN", null).?.value);
}

test "set replaces a value in place rather than appending a duplicate" {
    const allocator = testing.allocator;
    var store = try tempStore(allocator, "replace");
    defer {
        io_helper.deleteFile(store.path) catch {};
        store.deinit();
    }

    try store.set(default_key, null, "first");
    try store.set(default_key, null, "second");

    try testing.expectEqual(@as(usize, 1), store.entries.items.len);
    try testing.expectEqualStrings("second", store.get(default_key, null).?.value);
}

test "remove only deletes the matching scope" {
    const allocator = testing.allocator;
    var store = try tempStore(allocator, "remove");
    defer {
        io_helper.deleteFile(store.path) catch {};
        store.deinit();
    }

    try store.set(default_key, null, "global");
    try store.set(default_key, "https://registry.pantry.dev", "scoped");

    try testing.expect(store.remove(default_key, "https://registry.pantry.dev"));
    try testing.expect(!store.remove(default_key, "https://registry.pantry.dev"));
    try testing.expectEqualStrings("global", store.get(default_key, null).?.value);
}

test "masking never reveals a usable secret" {
    const allocator = testing.allocator;

    const long = try mask(allocator, "ptry_0123456789abcdef");
    defer allocator.free(long);
    try testing.expectEqualStrings("ptry...cdef", long);

    const short = try mask(allocator, "abc");
    defer allocator.free(short);
    try testing.expectEqualStrings("********", short);
}

test "saved credentials are not readable by other users" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    const allocator = testing.allocator;
    var store = try tempStore(allocator, "perms");
    defer {
        io_helper.deleteFile(store.path) catch {};
        store.deinit();
    }

    try store.set(default_key, null, "ptry_secret");
    try store.save();

    // Straight to libc: io_helper.statFile reports mode 0 on macOS, which would
    // make this assertion pass for a world-readable file.
    var path_z: [std.fs.max_path_bytes:0]u8 = undefined;
    @memcpy(path_z[0..store.path.len], store.path);
    path_z[store.path.len] = 0;

    var st: std.c.Stat = undefined;
    try testing.expectEqual(@as(c_int, 0), std.c.stat(@ptrCast(&path_z), &st));
    try testing.expectEqual(@as(u32, 0o600), @as(u32, @intCast(st.mode)) & 0o777);
}
