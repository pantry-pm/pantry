//! Services a project's `.env` names, inferred as dependencies (#36).
//!
//! Laravel and Stacks projects choose their database in `.env`
//! (`DB_CONNECTION=pgsql`) rather than in a dependency file, so a fresh
//! checkout could `pantry install` cleanly and then fail to start because the
//! database server was never installed. `pantry install` now reads these keys
//! and adds the matching package:
//!
//!   DB_CONNECTION  pgsql | postgres | postgresql  ->  postgresql.org
//!                  mysql                          ->  mysql.com
//!                  mariadb                        ->  mariadb.com/server
//!                  sqlite | sqlite3               ->  sqlite.org
//!   CACHE_DRIVER, CACHE_STORE, QUEUE_CONNECTION,
//!   QUEUE_DRIVER, SESSION_DRIVER  = redis         ->  redis.io
//!
//! Rules:
//!   - An explicit declaration always wins. If the dependency file names the
//!     package in any spelling (`postgres`, `postgresql.org@17`, ...), nothing
//!     is added and its pin is untouched.
//!   - Only those keys are read, and only a recognised driver name is ever
//!     printed; no other `.env` value leaves this file.
//!   - Under `--frozen-lockfile` the lockfile is the contract: a package is
//!     inferred only if `pantry.lock` already records it, so CI never drifts
//!     from the committed lock.
//!   - `PANTRY_ENV_DEPS=0` (or `false`/`off`) turns the whole thing off.

const std = @import("std");
const io_helper = @import("../../../io_helper.zig");
const style = @import("../../style.zig");
const parser = @import("../../../deps/parser.zig");
const helpers = @import("helpers.zig");

pub const opt_out_env = "PANTRY_ENV_DEPS";

pub const Inference = struct {
    /// Registry domain to install. Static.
    domain: []const u8,
    /// The `.env` key that named it. Static.
    key: []const u8,
    /// The recognised driver value. Static (never a slice of `.env`).
    driver: []const u8,
};

const DbDriver = struct { value: []const u8, domain: []const u8 };

const db_drivers = [_]DbDriver{
    .{ .value = "pgsql", .domain = "postgresql.org" },
    .{ .value = "postgres", .domain = "postgresql.org" },
    .{ .value = "postgresql", .domain = "postgresql.org" },
    .{ .value = "mysql", .domain = "mysql.com" },
    .{ .value = "mariadb", .domain = "mariadb.com/server" },
    .{ .value = "sqlite", .domain = "sqlite.org" },
    .{ .value = "sqlite3", .domain = "sqlite.org" },
};

const redis_keys = [_][]const u8{ "CACHE_DRIVER", "CACHE_STORE", "QUEUE_CONNECTION", "QUEUE_DRIVER", "SESSION_DRIVER" };

pub const max_inferences = 2; // one database, one redis

fn unquote(raw: []const u8) []const u8 {
    var v = std.mem.trim(u8, raw, " \t\r");
    if (v.len >= 2 and (v[0] == '"' or v[0] == '\'') and v[v.len - 1] == v[0]) return v[1 .. v.len - 1];
    // Unquoted: an inline ` # comment` ends the value.
    if (std.mem.indexOf(u8, v, " #")) |i| v = std.mem.trimEnd(u8, v[0..i], " \t");
    return v;
}

/// Parse `.env` content into the services it names. Pure. The last
/// assignment of a key wins, as it does when the file is loaded.
pub fn inferFromEnv(content: []const u8, out: *[max_inferences]Inference) []Inference {
    var db: ?Inference = null;
    // Per key, since each is assigned independently: is it redis right now?
    var redis_on: [redis_keys.len]bool = @splat(false);

    var lines = std.mem.splitScalar(u8, content, '\n');
    while (lines.next()) |line| {
        var s = std.mem.trim(u8, line, " \t\r");
        if (s.len == 0 or s[0] == '#') continue;
        if (std.mem.startsWith(u8, s, "export ")) s = std.mem.trimStart(u8, s["export ".len..], " \t");
        const eq = std.mem.indexOfScalar(u8, s, '=') orelse continue;
        const key = std.mem.trim(u8, s[0..eq], " \t");
        const value = unquote(s[eq + 1 ..]);

        if (std.mem.eql(u8, key, "DB_CONNECTION")) {
            db = null;
            for (db_drivers) |d| {
                if (std.ascii.eqlIgnoreCase(value, d.value)) {
                    db = .{ .domain = d.domain, .key = "DB_CONNECTION", .driver = d.value };
                    break;
                }
            }
            continue;
        }
        for (redis_keys, 0..) |rk, i| {
            if (std.mem.eql(u8, key, rk)) {
                redis_on[i] = std.ascii.eqlIgnoreCase(value, "redis");
                break;
            }
        }
    }

    var redis: ?Inference = null;
    for (redis_keys, redis_on) |rk, on| {
        if (on) {
            redis = .{ .domain = "redis.io", .key = rk, .driver = "redis" };
            break;
        }
    }

    var n: usize = 0;
    if (db) |d| {
        out[n] = d;
        n += 1;
    }
    if (redis) |r| {
        out[n] = r;
        n += 1;
    }
    return out[0..n];
}

/// Does the dependency list already name `domain`, in any spelling?
pub fn isDeclared(declared: []const parser.PackageDependency, domain: []const u8) bool {
    for (declared) |dep| {
        var name = helpers.normalizePackageName(dep.name);
        // `postgresql.org@17` written as a single key.
        if (std.mem.lastIndexOfScalar(u8, name, '@')) |at| {
            if (at > 0) name = name[0..at];
        }
        if (std.mem.eql(u8, helpers.resolvePackageAlias(name), domain)) return true;
    }
    return false;
}

pub fn isEnabled() bool {
    const val = io_helper.getenv(opt_out_env) orelse return true;
    return !(std.mem.eql(u8, val, "0") or std.ascii.eqlIgnoreCase(val, "false") or std.ascii.eqlIgnoreCase(val, "off") or std.ascii.eqlIgnoreCase(val, "no"));
}

fn lockfileHas(allocator: std.mem.Allocator, project_dir: []const u8, domain: []const u8) bool {
    const lockfile_reader = @import("../../../packages/lockfile.zig");
    const path = std.fs.path.join(allocator, &.{ project_dir, "pantry.lock" }) catch return false;
    defer allocator.free(path);
    var lock = lockfile_reader.readLockfile(allocator, path) catch return false;
    defer lock.deinit(allocator);
    if (lock.packages.get(domain) != null) return true;
    var it = lock.packages.iterator();
    while (it.next()) |entry| {
        if (std.mem.eql(u8, entry.value_ptr.name, domain)) return true;
    }
    return false;
}

pub const Options = struct {
    frozen_lockfile: bool = false,
    /// Print what was added and why.
    report: bool = true,
};

/// Dependencies inferred for `project_dir`, beyond those `declared`. The
/// returned entries (and their name/version strings) are owned by the caller;
/// free them with `freeDeps`.
pub fn infer(
    allocator: std.mem.Allocator,
    project_dir: []const u8,
    declared: []const parser.PackageDependency,
    options: Options,
) ![]parser.PackageDependency {
    if (!isEnabled()) return &.{};

    const env_path = try std.fs.path.join(allocator, &.{ project_dir, ".env" });
    defer allocator.free(env_path);
    const content = io_helper.readFileAlloc(allocator, env_path, 1024 * 1024) catch return &.{};
    defer allocator.free(content);

    var buf: [max_inferences]Inference = undefined;
    const found = inferFromEnv(content, &buf);
    if (found.len == 0) return &.{};

    var added: std.ArrayList(parser.PackageDependency) = .empty;
    errdefer freeDeps(allocator, added.items);
    defer added.deinit(allocator);

    for (found) |inf| {
        if (isDeclared(declared, inf.domain)) continue;
        if (isDeclared(added.items, inf.domain)) continue;
        if (options.frozen_lockfile and !lockfileHas(allocator, project_dir, inf.domain)) continue;

        const name = try allocator.dupe(u8, inf.domain);
        errdefer allocator.free(name);
        const version = try allocator.dupe(u8, "latest");
        errdefer allocator.free(version);
        try added.append(allocator, .{ .name = name, .version = version, .source = .pantry });

        if (options.report) {
            style.print("  + {s} (from {s}={s} in .env; {s}=0 to skip)\n", .{ inf.domain, inf.key, inf.driver, opt_out_env });
        }
    }
    return added.toOwnedSlice(allocator);
}

pub fn freeDeps(allocator: std.mem.Allocator, deps: []const parser.PackageDependency) void {
    for (deps) |dep| {
        var owned = dep;
        owned.deinit(allocator);
    }
    if (deps.len > 0) allocator.free(deps);
}

// ============================================================================
// Tests
// ============================================================================

const testing = std.testing;

fn inferOne(content: []const u8) []Inference {
    const S = struct {
        var buf: [max_inferences]Inference = undefined;
    };
    return inferFromEnv(content, &S.buf);
}

test "DB_CONNECTION maps each driver to its registry package" {
    const cases = [_]struct { env: []const u8, domain: []const u8 }{
        .{ .env = "DB_CONNECTION=pgsql", .domain = "postgresql.org" },
        .{ .env = "DB_CONNECTION=postgres", .domain = "postgresql.org" },
        .{ .env = "DB_CONNECTION=postgresql", .domain = "postgresql.org" },
        .{ .env = "DB_CONNECTION=mysql", .domain = "mysql.com" },
        .{ .env = "DB_CONNECTION=mariadb", .domain = "mariadb.com/server" },
        .{ .env = "DB_CONNECTION=sqlite", .domain = "sqlite.org" },
        .{ .env = "DB_CONNECTION=\"pgsql\"", .domain = "postgresql.org" },
        .{ .env = "export DB_CONNECTION='MySQL'", .domain = "mysql.com" },
        .{ .env = "DB_CONNECTION=pgsql # local dev", .domain = "postgresql.org" },
    };
    for (cases) |c| {
        const got = inferOne(c.env);
        try testing.expectEqual(@as(usize, 1), got.len);
        try testing.expectEqualStrings(c.domain, got[0].domain);
        try testing.expectEqualStrings("DB_CONNECTION", got[0].key);
    }
}

test "unknown drivers, comments and other keys infer nothing" {
    try testing.expectEqual(@as(usize, 0), inferOne("DB_CONNECTION=dynamodb").len);
    try testing.expectEqual(@as(usize, 0), inferOne("# DB_CONNECTION=pgsql").len);
    try testing.expectEqual(@as(usize, 0), inferOne("DB_HOST=postgres\nDB_DATABASE=mysql").len);
    try testing.expectEqual(@as(usize, 0), inferOne("CACHE_DRIVER=memory\nQUEUE_DRIVER=sync").len);
    try testing.expectEqual(@as(usize, 0), inferOne("").len);
}

test "the last assignment wins, as when the file is loaded" {
    const got = inferOne("DB_CONNECTION=pgsql\nDB_CONNECTION=sqlite\n");
    try testing.expectEqual(@as(usize, 1), got.len);
    try testing.expectEqualStrings("sqlite.org", got[0].domain);
    try testing.expectEqual(@as(usize, 0), inferOne("DB_CONNECTION=pgsql\nDB_CONNECTION=dynamodb\n").len);
}

test "redis drivers infer redis.io once, alongside the database" {
    const got = inferOne("DB_CONNECTION=pgsql\nCACHE_DRIVER=redis\nQUEUE_CONNECTION=redis\nSESSION_DRIVER=file\n");
    try testing.expectEqual(@as(usize, 2), got.len);
    try testing.expectEqualStrings("postgresql.org", got[0].domain);
    try testing.expectEqualStrings("redis.io", got[1].domain);
    try testing.expectEqualStrings("CACHE_DRIVER", got[1].key);
    try testing.expectEqual(@as(usize, 1), inferOne("QUEUE_DRIVER=redis").len);
    try testing.expectEqual(@as(usize, 0), inferOne("CACHE_STORE=redis\nCACHE_STORE=file").len);
    // Another key moving off redis does not cancel one that is still on it.
    try testing.expectEqual(@as(usize, 1), inferOne("QUEUE_DRIVER=redis\nCACHE_STORE=redis\nCACHE_STORE=file").len);
}

test "an explicit declaration in any spelling suppresses inference" {
    const mk = struct {
        fn dep(name: []const u8) parser.PackageDependency {
            return .{ .name = name, .version = "17" };
        }
    }.dep;
    try testing.expect(isDeclared(&.{mk("postgresql.org")}, "postgresql.org"));
    try testing.expect(isDeclared(&.{mk("postgres")}, "postgresql.org"));
    try testing.expect(isDeclared(&.{mk("postgresql.org@17")}, "postgresql.org"));
    try testing.expect(isDeclared(&.{mk("auto:redis")}, "redis.io"));
    try testing.expect(isDeclared(&.{mk("mariadb")}, "mariadb.com/server"));
    try testing.expect(!isDeclared(&.{ mk("bun.sh"), mk("@stacksjs/cli") }, "postgresql.org"));
}

fn writeFixture(dir: std.testing.TmpDir, name: []const u8, content: []const u8) !void {
    const file = try dir.dir.createFile(io_helper.io, name, .{});
    defer file.close(io_helper.io);
    try io_helper.writeAllToFile(file, content);
}

test "infer reads the project's .env and never overrides an explicit pin" {
    const allocator = testing.allocator;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const dir = buf[0..try tmp.dir.realPath(io_helper.io, &buf)];

    // No .env: nothing.
    const none = try infer(allocator, dir, &.{}, .{ .report = false });
    defer freeDeps(allocator, none);
    try testing.expectEqual(@as(usize, 0), none.len);

    try writeFixture(tmp, ".env", "APP_KEY=base64:secret\nDB_CONNECTION=pgsql\nDB_PASSWORD=hunter2\nCACHE_DRIVER=redis\n");

    const added = try infer(allocator, dir, &.{}, .{ .report = false });
    defer freeDeps(allocator, added);
    try testing.expectEqual(@as(usize, 2), added.len);
    try testing.expectEqualStrings("postgresql.org", added[0].name);
    try testing.expectEqualStrings("latest", added[0].version);
    try testing.expectEqual(parser.DependencySource.pantry, added[0].source);
    try testing.expectEqualStrings("redis.io", added[1].name);

    // deps.yaml pins postgres@17: the pin stands, only redis is inferred.
    const declared = [_]parser.PackageDependency{.{ .name = "postgres", .version = "17" }};
    const with_pin = try infer(allocator, dir, &declared, .{ .report = false });
    defer freeDeps(allocator, with_pin);
    try testing.expectEqual(@as(usize, 1), with_pin.len);
    try testing.expectEqualStrings("redis.io", with_pin[0].name);
}

test "under --frozen-lockfile only packages the lockfile records are inferred" {
    const allocator = testing.allocator;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const dir = buf[0..try tmp.dir.realPath(io_helper.io, &buf)];

    try writeFixture(tmp, ".env", "DB_CONNECTION=pgsql\nQUEUE_CONNECTION=redis\n");

    // No lockfile at all: frozen infers nothing.
    const without_lock = try infer(allocator, dir, &.{}, .{ .frozen_lockfile = true, .report = false });
    defer freeDeps(allocator, without_lock);
    try testing.expectEqual(@as(usize, 0), without_lock.len);

    try writeFixture(tmp, "pantry.lock",
        \\{
        \\  "version": "1",
        \\  "lockfileVersion": 1,
        \\  "generatedAt": "2026-10-03T00:00:00Z",
        \\  "packages": {
        \\    "postgresql.org@17.6.0": { "name": "postgresql.org", "version": "17.6.0", "source": "pantry" }
        \\  }
        \\}
    );
    const with_lock = try infer(allocator, dir, &.{}, .{ .frozen_lockfile = true, .report = false });
    defer freeDeps(allocator, with_lock);
    try testing.expectEqual(@as(usize, 1), with_lock.len);
    try testing.expectEqualStrings("postgresql.org", with_lock[0].name);
}
