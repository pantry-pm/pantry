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
//!   - An inference never reaches `pantry.lock`, neither as a constraint nor
//!     as a package entry, and neither does anything it drags in. The lock
//!     records what the workspace declares, so it has to read the same on
//!     every machine; a service read out of someone's local `.env` does not.
//!     Writing them in made a lock cut on a Postgres machine carry
//!     postgresql.org, gnome.org/libxslt and unicode.org, which a checkout
//!     without that `.env` then removed again (#253).
//!   - Because of that rule, `--frozen-lockfile` needs no special case here:
//!     an inference cannot move the lock, so it cannot drift from it either.
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

/// The registry domain a dependency name refers to, in any spelling
/// (`postgres`, `auto:redis`, `postgresql.org@17`).
pub fn canonicalDomain(dep_name: []const u8) []const u8 {
    var name = helpers.normalizePackageName(dep_name);
    // `postgresql.org@17` written as a single key.
    if (std.mem.lastIndexOfScalar(u8, name, '@')) |at| {
        if (at > 0) name = name[0..at];
    }
    return helpers.resolvePackageAlias(name);
}

/// Does the dependency list already name `domain`, in any spelling?
pub fn isDeclared(declared: []const parser.PackageDependency, domain: []const u8) bool {
    for (declared) |dep| {
        if (std.mem.eql(u8, canonicalDomain(dep.name), domain)) return true;
    }
    return false;
}

pub fn isEnabled() bool {
    const val = io_helper.getenv(opt_out_env) orelse return true;
    return !(std.mem.eql(u8, val, "0") or std.ascii.eqlIgnoreCase(val, "false") or std.ascii.eqlIgnoreCase(val, "off") or std.ascii.eqlIgnoreCase(val, "no"));
}

pub const Options = struct {
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

/// A set of registry domains, owning its keys.
pub const DomainSet = struct {
    allocator: std.mem.Allocator,
    map: std.StringHashMap(void),

    pub fn contains(self: DomainSet, domain: []const u8) bool {
        return self.map.contains(domain);
    }

    pub fn deinit(self: *DomainSet) void {
        var it = self.map.keyIterator();
        while (it.next()) |key| self.allocator.free(key.*);
        self.map.deinit();
    }
};

/// Walk `seeds` and everything the catalog says they need. `visit` is called
/// with each domain reached, seeds included, once each.
fn walkCatalog(
    allocator: std.mem.Allocator,
    seeds: []const []const u8,
    context: anytype,
    comptime visit: fn (@TypeOf(context), []const u8) anyerror!void,
) !void {
    const generated = @import("../../../packages/generated.zig");
    const pipeline = @import("../../../install/pipeline.zig");

    var seen = std.StringHashMap(void).init(allocator);
    defer seen.deinit();

    var frontier: std.ArrayList([]const u8) = .empty;
    defer frontier.deinit(allocator);
    for (seeds) |seed| try frontier.append(allocator, seed);

    while (frontier.pop()) |domain| {
        if ((try seen.getOrPut(domain)).found_existing) continue;
        try visit(context, domain);
        const info = generated.getPackageByDomain(domain) orelse continue;
        for (info.dependencies) |spec| {
            // Any OS's guard: a lock is written on one platform and read on
            // another, so what the other one would pull in counts too.
            const parsed = pipeline.parseAnyOsDepSpec(spec) orelse continue;
            try frontier.append(allocator, parsed.domain);
        }
    }
}

/// Domains that are in this install ONLY because `.env` named a service.
///
/// The inferred roots, plus everything the package catalog says they pull in,
/// minus everything a declared dependency pulls in. The subtraction is the
/// point: `unicode.org` arrives with postgresql.org here, but a workspace that
/// declares something else needing it has it on its own merits, and leaving
/// that out of the lock would make the lock depend on the local `.env` in the
/// opposite direction.
///
/// The transitive half is what made this a set rather than a name check: the
/// lock cut on a Postgres machine gained gnome.org/libxslt and unicode.org as
/// well as postgresql.org itself (#253).
///
/// The caller owns the result.
pub fn inferredOnlyDomains(
    allocator: std.mem.Allocator,
    inferred: []const parser.PackageDependency,
    declared: []const parser.PackageDependency,
) !DomainSet {
    var set = DomainSet{ .allocator = allocator, .map = std.StringHashMap(void).init(allocator) };
    errdefer set.deinit();
    if (inferred.len == 0) return set;

    var inferred_roots: std.ArrayList([]const u8) = .empty;
    defer inferred_roots.deinit(allocator);
    for (inferred) |dep| try inferred_roots.append(allocator, canonicalDomain(dep.name));

    const Add = struct {
        fn visit(target: *DomainSet, domain: []const u8) anyerror!void {
            const gop = try target.map.getOrPut(domain);
            if (gop.found_existing) return;
            gop.key_ptr.* = target.allocator.dupe(u8, domain) catch |err| {
                _ = target.map.remove(domain);
                return err;
            };
        }
    };
    try walkCatalog(allocator, inferred_roots.items, &set, Add.visit);

    var declared_roots: std.ArrayList([]const u8) = .empty;
    defer declared_roots.deinit(allocator);
    for (declared) |dep| try declared_roots.append(allocator, canonicalDomain(dep.name));

    const Remove = struct {
        fn visit(target: *DomainSet, domain: []const u8) anyerror!void {
            if (target.map.fetchRemove(domain)) |removed| target.allocator.free(removed.key);
        }
    };
    try walkCatalog(allocator, declared_roots.items, &set, Remove.visit);

    return set;
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

test "inference is independent of the lockfile, in frozen runs too" {
    const allocator = testing.allocator;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const dir = buf[0..try tmp.dir.realPath(io_helper.io, &buf)];

    try writeFixture(tmp, ".env", "DB_CONNECTION=pgsql\nQUEUE_CONNECTION=redis\n");

    // No lockfile at all. Inference used to be gated on the lock recording the
    // package, which only held because inference itself had put it there; now
    // nothing it produces reaches the lock, so there is nothing to gate on and
    // a --frozen-lockfile run infers exactly what any other run does (#253).
    const inferred = try infer(allocator, dir, &.{}, .{ .report = false });
    defer freeDeps(allocator, inferred);
    try testing.expectEqual(@as(usize, 2), inferred.len);
    try testing.expectEqualStrings("postgresql.org", inferred[0].name);
    try testing.expectEqualStrings("redis.io", inferred[1].name);
}

test "inferred-only domains cover what an inference drags in" {
    const allocator = testing.allocator;
    const mk = struct {
        fn dep(name: []const u8) parser.PackageDependency {
            return .{ .name = name, .version = "latest" };
        }
    }.dep;

    var set = try inferredOnlyDomains(allocator, &.{mk("postgresql.org")}, &.{mk("bun.sh")});
    defer set.deinit();

    // The root itself, and the transitive entries that appeared in the lock
    // alongside it in the reported failure.
    try testing.expect(set.contains("postgresql.org"));
    try testing.expect(set.contains("gnome.org/libxslt"));
    try testing.expect(set.contains("unicode.org"));
    try testing.expect(!set.contains("bun.sh"));
}

test "a domain a declared package also needs is not inferred-only" {
    const allocator = testing.allocator;
    const mk = struct {
        fn dep(name: []const u8) parser.PackageDependency {
            return .{ .name = name, .version = "latest" };
        }
    }.dep;

    // Declaring postgres outright leaves nothing attributable to the .env...
    var declared = try inferredOnlyDomains(allocator, &.{mk("postgresql.org")}, &.{mk("postgres")});
    defer declared.deinit();
    try testing.expect(!declared.contains("postgresql.org"));
    try testing.expect(!declared.contains("unicode.org"));

    // ...and so does declaring something that needs the same library: the lock
    // must not lose an entry that package needs on its own merits.
    var shared = try inferredOnlyDomains(allocator, &.{mk("postgresql.org")}, &.{mk("gnome.org/libxslt")});
    defer shared.deinit();
    try testing.expect(shared.contains("postgresql.org"));
    try testing.expect(!shared.contains("gnome.org/libxslt"));

    // Nothing inferred, nothing to exclude.
    var empty = try inferredOnlyDomains(allocator, &.{}, &.{mk("postgresql.org")});
    defer empty.deinit();
    try testing.expectEqual(@as(u32, 0), empty.map.count());
}
