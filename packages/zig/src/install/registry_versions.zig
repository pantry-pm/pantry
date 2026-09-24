//! Choosing a version out of a binary registry `metadata.json`.
//!
//! The `versions` object is not a list of installable releases. Two kinds of
//! key in it must not win an unversioned install:
//!
//! - Placeholders. The registry advertises versions the pkgx fallback can
//!   materialize on demand as `{tarball, sha256: "", size: 0}`. python.org
//!   carried 3.14.7 that way with nothing behind the tarball URL, and because
//!   3.14.7 was the highest key, `pantry install -g python.org` picked it and
//!   failed with "not found in registry" while 3.14.6 was complete.
//! - Prereleases. libgeos.org lists 3.15.0beta1..rc1 beside stable 3.14.x, and
//!   the old comparison looked only at major.minor.patch, so an unversioned
//!   install landed on 3.15.0beta1.
//!
//! So `latest` (or `*`, or nothing) means the newest stable version with a
//! complete artifact for this platform. A placeholder is still used when no
//! complete artifact satisfies the request — an explicit `pkg@3.14.7` is the
//! only way to reach a version that exists only on pkgx — and a prerelease
//! when the package has never shipped a stable release.

const std = @import("std");
const semver = @import("../packages/semver.zig");

pub const isPrerelease = semver.isPrerelease;

pub const Selection = struct {
    /// A key of the `versions` object, borrowed from the parsed JSON.
    version: []const u8,
    /// The `platforms.<platform>` record for that version.
    platform_info: std.json.Value,
};

/// True for a platform record that points at uploaded bytes: a non-empty
/// sha256 and a non-zero size. A record that omits `size` is judged by its
/// checksum alone.
pub fn isCompleteArtifact(platform_info: std.json.Value) bool {
    if (platform_info != .object) return false;
    const sha = platform_info.object.get("sha256") orelse return false;
    if (sha != .string or sha.string.len == 0) return false;
    if (platform_info.object.get("size")) |size| switch (size) {
        .integer => |n| if (n <= 0) return false,
        .float => |f| if (f <= 0) return false,
        .null => {},
        else => return false,
    };
    return true;
}

/// True for "latest", "*" and an empty constraint.
pub fn isUnversioned(version_constraint: []const u8) bool {
    return version_constraint.len == 0 or
        std.mem.eql(u8, version_constraint, "latest") or
        std.mem.eql(u8, version_constraint, "*");
}

/// Pick the best version in a metadata `versions` object for `platform`.
///
/// Preference, highest first: a stable release (unversioned requests only —
/// a constraint already decides whether prereleases are allowed), a complete
/// artifact, then the newest version.
pub fn select(
    versions_obj: std.json.ObjectMap,
    version_constraint: []const u8,
    platform: []const u8,
) ?Selection {
    const unversioned = isUnversioned(version_constraint);
    const constraint: ?semver.Constraint = if (unversioned)
        null
    else
        semver.parseConstraint(version_constraint) catch return null;

    var best: ?Selection = null;
    var best_rank: u2 = 0;

    var it = versions_obj.iterator();
    while (it.next()) |entry| {
        const version = entry.key_ptr.*;
        if (constraint) |c| {
            if (!semver.satisfiesConstraint(version, c)) continue;
        } else {
            // Skip keys that are not versions at all.
            _ = semver.parseVersion(version) catch continue;
        }

        const version_info = entry.value_ptr.*;
        if (version_info != .object) continue;
        const platforms_obj = version_info.object.get("platforms") orelse continue;
        if (platforms_obj != .object) continue;
        const platform_info = platforms_obj.object.get(platform) orelse continue;
        if (platform_info != .object) continue;

        const stable = !unversioned or !semver.isPrerelease(version);
        const rank: u2 = (@as(u2, @intFromBool(stable)) << 1) | @intFromBool(isCompleteArtifact(platform_info));

        if (best) |current| {
            if (rank < best_rank) continue;
            if (rank == best_rank and semver.compareVersions(version, current.version) != .gt) continue;
        }
        best = .{ .version = version, .platform_info = platform_info };
        best_rank = rank;
    }

    return best;
}

// ============================================================================
// Tests
// ============================================================================

fn parseFixture(json: []const u8) !std.json.Parsed(std.json.Value) {
    return std.json.parseFromSlice(std.json.Value, std.testing.allocator, json, .{});
}

fn selectFrom(parsed: std.json.Parsed(std.json.Value), constraint: []const u8, platform: []const u8) ?[]const u8 {
    const versions = parsed.value.object.get("versions").?.object;
    return if (select(versions, constraint, platform)) |s| s.version else null;
}

// python.org as the registry served it: 3.14.7 is the highest key, but only a
// placeholder for linux-x86-64, while 3.14.6 is a real upload.
const python_fixture =
    \\{"name":"python.org","latestVersion":"3.14.6","versions":{
    \\  "3.14.5":{"platforms":{"linux-x86-64":{"tarball":"binaries/python.org/3.14.5/linux-x86-64/python.org-3.14.5.tar.gz","sha256":"aa11","size":120000000,"uploadedAt":"2026-05-01T00:00:00.000Z"}}},
    \\  "3.14.7":{"platforms":{"linux-x86-64":{"tarball":"binaries/python.org/3.14.7/linux-x86-64/python.org-3.14.7.tar.gz","sha256":"","size":0,"uploadedAt":""}}},
    \\  "3.14.6":{"platforms":{"linux-x86-64":{"tarball":"binaries/python.org/3.14.6/linux-x86-64/python.org-3.14.6.tar.gz","sha256":"16bc","size":126386342,"uploadedAt":"2026-06-11T10:19:01.088Z"}}}
    \\}}
;

test "latest skips a placeholder upload for the newest complete one" {
    const parsed = try parseFixture(python_fixture);
    defer parsed.deinit();

    try std.testing.expectEqualStrings("3.14.6", selectFrom(parsed, "latest", "linux-x86-64").?);
    try std.testing.expectEqualStrings("3.14.6", selectFrom(parsed, "", "linux-x86-64").?);
    try std.testing.expectEqualStrings("3.14.6", selectFrom(parsed, "*", "linux-x86-64").?);
    // A range prefers the complete artifact the same way.
    try std.testing.expectEqualStrings("3.14.6", selectFrom(parsed, "^3.14", "linux-x86-64").?);
}

test "an explicitly requested placeholder version is still offered" {
    const parsed = try parseFixture(python_fixture);
    defer parsed.deinit();

    // The only way to reach a version the pkgx fallback materializes lazily.
    try std.testing.expectEqualStrings("3.14.7", selectFrom(parsed, "3.14.7", "linux-x86-64").?);
    try std.testing.expect(selectFrom(parsed, "latest", "darwin-arm64") == null);
}

test "placeholders are used when nothing complete exists" {
    const parsed = try parseFixture(
        \\{"versions":{
        \\  "1.0.0":{"platforms":{"linux-x86-64":{"tarball":"a","sha256":"","size":0}}},
        \\  "1.1.0":{"platforms":{"linux-x86-64":{"tarball":"b","sha256":"","size":0}}}
        \\}}
    );
    defer parsed.deinit();

    try std.testing.expectEqualStrings("1.1.0", selectFrom(parsed, "latest", "linux-x86-64").?);
}

test "isCompleteArtifact requires a checksum and a non-zero size" {
    const parsed = try parseFixture(
        \\[{"sha256":"abc","size":10},{"sha256":"","size":10},{"sha256":"abc","size":0},
        \\ {"size":10},{"sha256":"abc"},{"sha256":"abc","size":null}]
    );
    defer parsed.deinit();
    const records = parsed.value.array.items;

    try std.testing.expect(isCompleteArtifact(records[0]));
    try std.testing.expect(!isCompleteArtifact(records[1]));
    try std.testing.expect(!isCompleteArtifact(records[2]));
    try std.testing.expect(!isCompleteArtifact(records[3]));
    try std.testing.expect(isCompleteArtifact(records[4]));
    try std.testing.expect(isCompleteArtifact(records[5]));
}

// libgeos.org as the registry served it: beta and rc builds (with no dash in
// front of the tag) beside stable 3.14.x, and latestVersion on the rc.
const libgeos_fixture =
    \\{"name":"libgeos.org","latestVersion":"3.15.0rc1","versions":{
    \\  "3.15.0beta1":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"b1","size":2886462}}},
    \\  "3.14.1":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"s1","size":2800000}}},
    \\  "3.15.0rc1":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"r1","size":2886462}}},
    \\  "3.14.0":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"s0","size":2800000}}},
    \\  "3.15.0beta2":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"b2","size":2886462}}}
    \\}}
;

test "latest skips prereleases" {
    const parsed = try parseFixture(libgeos_fixture);
    defer parsed.deinit();

    try std.testing.expectEqualStrings("3.14.1", selectFrom(parsed, "latest", "linux-x86-64").?);
    try std.testing.expectEqualStrings("3.14.1", selectFrom(parsed, "", "linux-x86-64").?);
    // A stable range does not reach into a prerelease line either.
    try std.testing.expectEqualStrings("3.14.1", selectFrom(parsed, "^3.14", "linux-x86-64").?);
}

test "a prerelease is installable when asked for by name" {
    const parsed = try parseFixture(libgeos_fixture);
    defer parsed.deinit();

    try std.testing.expectEqualStrings("3.15.0rc1", selectFrom(parsed, "3.15.0rc1", "linux-x86-64").?);
    try std.testing.expectEqualStrings("3.15.0beta1", selectFrom(parsed, "3.15.0beta1", "linux-x86-64").?);
}

test "a stable release beats its own prereleases" {
    const parsed = try parseFixture(
        \\{"versions":{
        \\  "3.15.0rc1":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"r1","size":1}}},
        \\  "3.15.0":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"s","size":1}}},
        \\  "3.15.0beta1":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"b1","size":1}}}
        \\}}
    );
    defer parsed.deinit();

    try std.testing.expectEqualStrings("3.15.0", selectFrom(parsed, "latest", "linux-x86-64").?);
}

test "a package that only ships prereleases resolves to the newest one" {
    const parsed = try parseFixture(
        \\{"versions":{
        \\  "2.0.0beta3":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"b3","size":1}}},
        \\  "2.0.0rc1":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"r1","size":1}}},
        \\  "2.0.0alpha1":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"a1","size":1}}}
        \\}}
    );
    defer parsed.deinit();

    try std.testing.expectEqualStrings("2.0.0rc1", selectFrom(parsed, "latest", "linux-x86-64").?);
}

test "zig dev builds stay reachable through a dev range, and latest is stable" {
    const parsed = try parseFixture(
        \\{"versions":{
        \\  "0.16.0":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"s","size":1}}},
        \\  "0.17.0-dev.986+f3544a707":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"d1","size":1}}},
        \\  "0.17.0-dev.1422+e863bf3be":{"platforms":{"linux-x86-64":{"tarball":"t","sha256":"d2","size":1}}}
        \\}}
    );
    defer parsed.deinit();

    try std.testing.expectEqualStrings("0.16.0", selectFrom(parsed, "latest", "linux-x86-64").?);
    try std.testing.expectEqualStrings("0.17.0-dev.1422+e863bf3be", selectFrom(parsed, "0.17.0-dev", "linux-x86-64").?);
    try std.testing.expectEqualStrings("0.17.0-dev.1422+e863bf3be", selectFrom(parsed, "^0.17.0-dev", "linux-x86-64").?);
}
