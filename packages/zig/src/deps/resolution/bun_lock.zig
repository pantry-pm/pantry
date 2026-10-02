//! bun.lock pins, read so pantry resolves npm packages to the versions Bun did.
//!
//! A project that has both a `pantry.lock` and a `bun.lock` installs the same
//! npm packages twice: once by pantry into `pantry/`, once by Bun (which pantry
//! delegates to) into `node_modules/`. When each lockfile picks its own version
//! inside a range, the two trees disagree - `better-dx` 0.2.25 under `pantry/`
//! and 0.2.26 under `node_modules/` - and the same source runs against
//! different dependencies depending on which tree its imports resolve from
//! (stacksjs/stacks#2848).
//!
//! So when pantry resolves an npm range and `bun.lock` pins a version that
//! satisfies it, that pin wins: over pantry's own older pin, and over "highest
//! matching". A pin outside the range is ignored. Anything unreadable - no
//! `bun.lock`, only the binary `bun.lockb`, a malformed file - yields no pins,
//! and resolution behaves exactly as it did before.
//!
//! Only top-level entries are pins. In `bun.lock`'s `packages` object the key
//! of a hoisted package is its own name (`"@scope/pkg": ["@scope/pkg@1.2.3",
//! ...]`); a nested copy is keyed by its path (`"parent/child"`,
//! `"parent/@scope/child"`), and an `npm:` alias by the alias - in both cases
//! the key differs from the name inside `value[0]`, which is how they are told
//! apart. Workspace, git, file and link entries carry a non-numeric version and
//! are skipped too: they are not registry versions pantry could select.

const std = @import("std");
const io_helper = @import("../../io_helper.zig");
const jsonc = @import("../../utils/jsonc.zig");
const semver = @import("../../packages/semver.zig");

pub const BUN_LOCK_FILE_NAME = "bun.lock";

/// bun.lock files larger than this are not read (stacks' is ~100 KB).
const max_bun_lock_bytes = 64 * 1024 * 1024;

pub const BunLockPins = struct {
    allocator: std.mem.Allocator,
    /// package name -> pinned version; both owned.
    pins: std.StringHashMapUnmanaged([]const u8) = .empty,

    pub fn deinit(self: *BunLockPins) void {
        var it = self.pins.iterator();
        while (it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            self.allocator.free(entry.value_ptr.*);
        }
        self.pins.deinit(self.allocator);
    }

    pub fn count(self: *const BunLockPins) usize {
        return self.pins.count();
    }

    /// The version bun.lock pins for a top-level package, whatever the range.
    pub fn get(self: *const BunLockPins, name: []const u8) ?[]const u8 {
        return self.pins.get(name);
    }

    /// The version pantry must select for `name@range`: bun.lock's pin when it
    /// satisfies `range`, otherwise null (resolve as if there were no bun.lock).
    pub fn preferredVersion(self: *const BunLockPins, name: []const u8, range: []const u8) ?[]const u8 {
        return selectPinnedVersion(self.get(name), range);
    }

    /// Parse bun.lock text (JSONC: trailing commas and comments allowed).
    pub fn parse(allocator: std.mem.Allocator, content: []const u8) !BunLockPins {
        const no_comments = try jsonc.stripComments(allocator, content);
        defer allocator.free(no_comments);
        const json = try jsonc.stripTrailingCommas(allocator, no_comments);
        defer allocator.free(json);

        const parsed = try std.json.parseFromSlice(std.json.Value, allocator, json, .{});
        defer parsed.deinit();

        var result = BunLockPins{ .allocator = allocator };
        errdefer result.deinit();

        if (parsed.value != .object) return error.InvalidBunLock;
        const packages = parsed.value.object.get("packages") orelse return result;
        if (packages != .object) return error.InvalidBunLock;

        var it = packages.object.iterator();
        while (it.next()) |entry| {
            const key = entry.key_ptr.*;
            const value = entry.value_ptr.*;
            if (value != .array or value.array.items.len == 0) continue;
            const spec = value.array.items[0];
            if (spec != .string) continue;

            const name_version = splitNameVersion(spec.string) orelse continue;
            // Nested ("parent/child") and aliased entries are keyed by something
            // other than the package's own name: not the hoisted pin.
            if (!std.mem.eql(u8, key, name_version.name)) continue;
            if (!isRegistryVersion(name_version.version)) continue;

            if (result.pins.contains(key)) continue;
            const owned_name = try allocator.dupe(u8, key);
            errdefer allocator.free(owned_name);
            const owned_version = try allocator.dupe(u8, name_version.version);
            errdefer allocator.free(owned_version);
            try result.pins.put(allocator, owned_name, owned_version);
        }

        return result;
    }

    /// Load `<project_dir>/bun.lock`. Returns null - never an error - when it is
    /// missing, unreadable or malformed, so callers fall back silently. The
    /// binary `bun.lockb` is deliberately not read.
    pub fn load(allocator: std.mem.Allocator, project_dir: []const u8) ?BunLockPins {
        const path = std.fs.path.join(allocator, &.{ project_dir, BUN_LOCK_FILE_NAME }) catch return null;
        defer allocator.free(path);
        const content = io_helper.readFileAlloc(allocator, path, max_bun_lock_bytes) catch return null;
        defer allocator.free(content);
        return parse(allocator, content) catch null;
    }
};

const NameVersion = struct { name: []const u8, version: []const u8 };

/// Split "name@version" / "@scope/name@version" at the last '@' that is not
/// the scope marker.
fn splitNameVersion(spec: []const u8) ?NameVersion {
    const at = std.mem.lastIndexOfScalar(u8, spec, '@') orelse return null;
    if (at == 0 or at + 1 >= spec.len) return null;
    return .{ .name = spec[0..at], .version = spec[at + 1 ..] };
}

/// A concrete registry version ("1.2.3", "1.2.3-beta.1"), as opposed to
/// "workspace:packages/x", "github:owner/repo#sha", "file:..", "link:..".
fn isRegistryVersion(version: []const u8) bool {
    if (version.len == 0 or !std.ascii.isDigit(version[0])) return false;
    if (std.mem.indexOfScalar(u8, version, ':') != null) return false;
    _ = semver.parseVersion(version) catch return false;
    return true;
}

/// Choose bun.lock's pin for a range when it satisfies the range. Pure, so the
/// rule is testable apart from any file: null `pin` or an unsatisfied range
/// both mean "no preference".
pub fn selectPinnedVersion(pin: ?[]const u8, range: []const u8) ?[]const u8 {
    const version = pin orelse return null;
    return if (rangeAdmits(range, version)) version else null;
}

/// Does `version` satisfy the npm `range`? Conservative: a range shape this
/// does not understand answers false, which only means bun.lock's pin is not
/// preferred and pantry resolves the way it always has.
///
/// Understood: exact versions, `*` / `latest` / empty, `^` `~` `>=` `<=` `>`
/// `<` `=` comparators, whitespace-joined comparator sets (`>=1 <2`), `||`
/// alternatives, hyphen ranges (`1.0.0 - 2.0.0`) and x-ranges (`1.x`,
/// `1.2.*`). Not understood, so never matched: `workspace:`, `npm:`, `file:`,
/// `link:`, git and URL specs, dist-tags other than `latest`.
pub fn rangeAdmits(range_in: []const u8, version: []const u8) bool {
    const range = std.mem.trim(u8, range_in, " \t\r\n");
    _ = semver.parseVersion(version) catch return false;

    if (std.mem.eql(u8, range, version)) return true;
    if (range.len == 0 or std.mem.eql(u8, range, "*") or std.mem.eql(u8, range, "latest") or
        std.mem.eql(u8, range, "x") or std.mem.eql(u8, range, "X"))
    {
        return !semver.isPrerelease(version);
    }
    // Protocol specs (workspace:, npm:, file:, github:, https:) and owner/repo
    // shorthands do not name a registry range.
    if (std.mem.indexOfScalar(u8, range, ':') != null or std.mem.indexOfScalar(u8, range, '/') != null) return false;

    var alternatives = std.mem.splitSequence(u8, range, "||");
    while (alternatives.next()) |alt_raw| {
        const alt = std.mem.trim(u8, alt_raw, " \t");
        if (alt.len == 0) continue;
        if (alternativeAdmits(alt, version)) return true;
    }
    return false;
}

fn alternativeAdmits(alt: []const u8, version: []const u8) bool {
    // Hyphen range: "1.0.0 - 2.0.0" == ">=1.0.0 <=2.0.0".
    if (std.mem.indexOf(u8, alt, " - ")) |dash| {
        const low = std.mem.trim(u8, alt[0..dash], " \t");
        const high = std.mem.trim(u8, alt[dash + 3 ..], " \t");
        return comparatorAdmits(">=", low, version) and comparatorAdmits("<=", high, version);
    }

    var comparators = std.mem.tokenizeAny(u8, alt, " \t");
    var seen_any = false;
    while (comparators.next()) |comparator| {
        seen_any = true;
        const op_len = operatorLength(comparator);
        if (!comparatorAdmits(comparator[0..op_len], comparator[op_len..], version)) return false;
    }
    return seen_any;
}

fn operatorLength(comparator: []const u8) usize {
    if (std.mem.startsWith(u8, comparator, ">=") or std.mem.startsWith(u8, comparator, "<=")) return 2;
    if (comparator.len > 0 and switch (comparator[0]) {
        '^', '~', '>', '<', '=' => true,
        else => false,
    }) return 1;
    return 0;
}

fn comparatorAdmits(op: []const u8, operand_in: []const u8, version: []const u8) bool {
    const operand = stripXRange(operand_in);
    if (operand.len == 0) {
        // "*", "x", or ">=*" - anything (stable).
        return !semver.isPrerelease(version);
    }

    var buf: [128]u8 = undefined;
    const constraint_str = std.fmt.bufPrint(&buf, "{s}{s}", .{ op, operand }) catch return false;
    const constraint = semver.parseConstraint(constraint_str) catch return false;
    return semver.satisfiesConstraint(version, constraint);
}

/// "1.x" -> "1", "1.2.*" -> "1.2", "x" -> "". A bare "1" / "1.2" is already
/// read by semver.parseConstraint as ^1 / ~1.2, which is what the x-range means.
fn stripXRange(operand: []const u8) []const u8 {
    var s = operand;
    while (true) {
        if (std.mem.eql(u8, s, "x") or std.mem.eql(u8, s, "X") or std.mem.eql(u8, s, "*")) return "";
        if (std.mem.endsWith(u8, s, ".x") or std.mem.endsWith(u8, s, ".X") or std.mem.endsWith(u8, s, ".*")) {
            s = s[0 .. s.len - 2];
            continue;
        }
        return s;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "selectPinnedVersion prefers bun.lock's pin when it satisfies the range" {
    // The stacksjs/stacks#2848 case: pantry.lock had 0.2.25, bun.lock 0.2.26.
    try testing.expectEqualStrings("0.2.26", selectPinnedVersion("0.2.26", "^0.2.24").?);
    try testing.expectEqualStrings("0.11.64", selectPinnedVersion("0.11.64", "^0.11.55").?);
    try testing.expectEqualStrings("9.17.0", selectPinnedVersion("9.17.0", "^9.15.0").?);
}

test "selectPinnedVersion ignores a pin outside the range" {
    try testing.expect(selectPinnedVersion("0.3.0", "^0.2.24") == null);
    try testing.expect(selectPinnedVersion("2.0.0", "~1.4.0") == null);
    try testing.expect(selectPinnedVersion("1.0.0", "1.0.1") == null);
    try testing.expect(selectPinnedVersion(null, "^1.0.0") == null);
}

test "rangeAdmits understands the range shapes package.json files use" {
    try testing.expect(rangeAdmits("1.2.3", "1.2.3"));
    try testing.expect(rangeAdmits("=1.2.3", "1.2.3"));
    try testing.expect(rangeAdmits("*", "4.0.0"));
    try testing.expect(rangeAdmits("latest", "4.0.0"));
    try testing.expect(rangeAdmits("", "4.0.0"));
    try testing.expect(rangeAdmits(">=1.0.0 <2.0.0", "1.9.9"));
    try testing.expect(!rangeAdmits(">=1.0.0 <2.0.0", "2.0.0"));
    try testing.expect(rangeAdmits("^1.0.0 || ^2.0.0", "2.3.0"));
    try testing.expect(!rangeAdmits("^1.0.0 || ^2.0.0", "3.0.0"));
    try testing.expect(rangeAdmits("1.0.0 - 2.0.0", "2.0.0"));
    try testing.expect(!rangeAdmits("1.0.0 - 2.0.0", "2.0.1"));
    try testing.expect(rangeAdmits("1.x", "1.9.0"));
    try testing.expect(!rangeAdmits("1.x", "2.0.0"));
    try testing.expect(rangeAdmits("1.2.x", "1.2.7"));
    try testing.expect(!rangeAdmits("1.2.x", "1.3.0"));
    try testing.expect(rangeAdmits("0.x", "0.9.0"));
    try testing.expect(rangeAdmits("~2", "2.5.0"));
}

test "rangeAdmits never matches non-registry specs" {
    try testing.expect(!rangeAdmits("workspace:*", "1.0.0"));
    try testing.expect(!rangeAdmits("npm:string-width@^4.2.0", "4.2.3"));
    try testing.expect(!rangeAdmits("github:owner/repo", "1.0.0"));
    try testing.expect(!rangeAdmits("owner/repo#main", "1.0.0"));
    try testing.expect(!rangeAdmits("file:../local", "1.0.0"));
    try testing.expect(!rangeAdmits("https://example.com/x.tgz", "1.0.0"));
    try testing.expect(!rangeAdmits("next", "1.0.0"));
}

test "rangeAdmits keeps prereleases out of stable ranges" {
    try testing.expect(!rangeAdmits("^1.0.0", "1.1.0-beta.1"));
    try testing.expect(!rangeAdmits("*", "1.1.0-beta.1"));
    try testing.expect(rangeAdmits("1.1.0-beta.1", "1.1.0-beta.1"));
}

test "BunLockPins.parse reads only top-level registry pins" {
    const content =
        \\{
        \\  "lockfileVersion": 1,
        \\  // bun.lock is JSONC
        \\  "workspaces": {
        \\    "": { "name": "app", "dependencies": { "better-dx": "^0.2.24", }, },
        \\  },
        \\  "packages": {
        \\    "better-dx": ["better-dx@0.2.26", "", { "dependencies": { "pickier": "^0.1.40" } }, "sha512-abc"],
        \\    "@stacksjs/stx": ["@stacksjs/stx@0.2.347", "", {}, "sha512-def"],
        \\    "@stacksjs/actions": ["@stacksjs/actions@workspace:storage/framework/core/actions"],
        \\    "string-width-cjs": ["string-width@4.2.3", "", {}, "sha512-ghi"],
        \\    "string-width": ["string-width@5.1.2", "", {}, "sha512-jkl"],
        \\    "wrap-ansi/string-width": ["string-width@4.2.3", "", {}, "sha512-mno"],
        \\    "parent/@scope/child": ["@scope/child@1.0.0", "", {}, "sha512-pqr"],
        \\    "gitdep": ["gitdep@github:owner/gitdep#abc123", {}, "owner-gitdep-abc123"],
        \\  },
        \\}
    ;
    var pins = try BunLockPins.parse(testing.allocator, content);
    defer pins.deinit();

    try testing.expectEqual(@as(usize, 3), pins.count());
    try testing.expectEqualStrings("0.2.26", pins.get("better-dx").?);
    try testing.expectEqualStrings("0.2.347", pins.get("@stacksjs/stx").?);
    // The hoisted copy, not the nested one or the alias.
    try testing.expectEqualStrings("5.1.2", pins.get("string-width").?);
    try testing.expect(pins.get("string-width-cjs") == null);
    try testing.expect(pins.get("@scope/child") == null);
    try testing.expect(pins.get("@stacksjs/actions") == null);
    try testing.expect(pins.get("gitdep") == null);

    try testing.expectEqualStrings("0.2.26", pins.preferredVersion("better-dx", "^0.2.24").?);
    try testing.expect(pins.preferredVersion("better-dx", "^0.3.0") == null);
    try testing.expect(pins.preferredVersion("not-in-bun-lock", "^1.0.0") == null);
}

test "BunLockPins.parse rejects malformed input and load falls back to null" {
    try testing.expectError(error.InvalidBunLock, BunLockPins.parse(testing.allocator, "[1, 2]"));
    try testing.expect(std.meta.isError(BunLockPins.parse(testing.allocator, "{ not json")));

    var tmp_dir = testing.tmpDir(.{});
    defer tmp_dir.cleanup();
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const path_len = try tmp_dir.dir.realPath(io_helper.io, &path_buf);
    const project_dir = path_buf[0..path_len];

    // No bun.lock at all.
    try testing.expect(BunLockPins.load(testing.allocator, project_dir) == null);

    // A binary bun.lockb is never read.
    try tmp_dir.dir.writeFile(io_helper.io, .{ .sub_path = "bun.lockb", .data = "\x00\x01binary" });
    try testing.expect(BunLockPins.load(testing.allocator, project_dir) == null);

    // A corrupt bun.lock is ignored, not fatal.
    try tmp_dir.dir.writeFile(io_helper.io, .{ .sub_path = "bun.lock", .data = "{ \"packages\": { oops" });
    try testing.expect(BunLockPins.load(testing.allocator, project_dir) == null);

    try tmp_dir.dir.writeFile(io_helper.io, .{
        .sub_path = "bun.lock",
        .data = "{ \"packages\": { \"zod\": [\"zod@4.1.0\", \"\", {}, \"sha512-x\"], }, }",
    });
    var pins = BunLockPins.load(testing.allocator, project_dir).?;
    defer pins.deinit();
    try testing.expectEqualStrings("4.1.0", pins.get("zod").?);
}
