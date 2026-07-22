const std = @import("std");
const generated = @import("generated.zig");

/// Parsed semver version
pub const Version = struct {
    major: u32,
    minor: u32,
    patch: u32,
};

/// Semver constraint types
pub const ConstraintType = enum {
    exact, // 1.2.3
    caret, // ^1.2.3 - compatible with version
    tilde, // ~1.2.3 - approximately equivalent
    gte, // >=1.2.3
    lte, // <=1.2.3
    gt, // >1.2.3
    lt, // <1.2.3
};

pub const Constraint = struct {
    type: ConstraintType,
    major: u32,
    minor: u32,
    patch: u32,
    allows_prerelease: bool = false,
    prerelease_number: ?u64 = null,
    raw_version: ?[]const u8 = null,
};

/// Parse a semver version string into major.minor.patch
pub fn parseVersion(version: []const u8) !Version {
    var clean_version = version;

    // Strip 'v' prefix if present
    if (std.mem.startsWith(u8, clean_version, "v")) {
        clean_version = clean_version[1..];
    }

    // Split by '.' and '-' (for pre-release versions)
    var parts = std.mem.splitAny(u8, clean_version, ".-");

    const major_str = parts.next() orelse return error.InvalidVersion;
    // Missing minor/patch (e.g. "1" or "1.2") defaults to 0 — matches bun/npm behaviour.
    // But if present, they MUST parse cleanly — "1.invalid.3" is a real user error and
    // silently rewriting it to "1.0.0" masks corrupt lockfiles and typos upstream.
    const minor_str_opt = parts.next();
    const patch_str_opt = parts.next();

    const major = try parseComponent(major_str);
    const minor: u32 = if (minor_str_opt) |s| try parseComponent(s) else 0;
    const patch: u32 = if (patch_str_opt) |s| try parseComponent(s) else 0;

    return .{ .major = major, .minor = minor, .patch = patch };
}

/// Parse the numeric part of a single version component, tolerating a trailing
/// non-numeric suffix. openssl ships letter-suffixed patch releases like
/// "1.1.1w" (patch component "1w"); without this, `parseInt("1w")` fails and
/// every openssl 1.x version is treated as unparseable, so `^1` matches
/// nothing even though 1.1.1w is in the registry. Takes the leading ASCII
/// digits ("1w" -> 1) and ignores the suffix — but a component with NO leading
/// digit ("foo", "invalid") is still a genuine error, so real typos and corrupt
/// lockfiles are not silently rewritten to 0.
fn parseComponent(s: []const u8) !u32 {
    var end: usize = 0;
    while (end < s.len and s[end] >= '0' and s[end] <= '9') : (end += 1) {}
    if (end == 0) return error.InvalidVersion;
    return std.fmt.parseInt(u32, s[0..end], 10) catch error.InvalidVersion;
}

test "parseVersion rejects non-numeric components" {
    try std.testing.expectError(error.InvalidVersion, parseVersion("1.invalid.3"));
    try std.testing.expectError(error.InvalidVersion, parseVersion("1.2.foo"));
    // Short forms still accepted — npm treats "1" as "1.0.0"
    const short = try parseVersion("1");
    try std.testing.expectEqual(@as(u32, 1), short.major);
    try std.testing.expectEqual(@as(u32, 0), short.minor);
    try std.testing.expectEqual(@as(u32, 0), short.patch);
    // 'v' prefix still stripped
    const prefixed = try parseVersion("v1.2.3");
    try std.testing.expectEqual(@as(u32, 1), prefixed.major);
    try std.testing.expectEqual(@as(u32, 2), prefixed.minor);
    try std.testing.expectEqual(@as(u32, 3), prefixed.patch);
}

test "parseVersion accepts openssl-style letter-suffixed patch (1.1.1w)" {
    // openssl ships "1.1.1w"; the trailing letter must not make the whole
    // version unparseable, or `^1` matches none of the 1.x line.
    const v = try parseVersion("1.1.1w");
    try std.testing.expectEqual(@as(u32, 1), v.major);
    try std.testing.expectEqual(@as(u32, 1), v.minor);
    try std.testing.expectEqual(@as(u32, 1), v.patch);
    // But a component with no leading digit is still rejected.
    try std.testing.expectError(error.InvalidVersion, parseVersion("1.2.foo"));
}

/// Parse a version constraint string like "^1.2.3" or ">=1.0.0"
pub fn parseConstraint(constraint_str: []const u8) !Constraint {
    var version_str = constraint_str;
    var constraint_type = ConstraintType.exact;

    // Detect constraint type and strip prefix
    if (std.mem.startsWith(u8, version_str, "^")) {
        constraint_type = .caret;
        version_str = version_str[1..];
    } else if (std.mem.startsWith(u8, version_str, "~")) {
        constraint_type = .tilde;
        version_str = version_str[1..];
    } else if (std.mem.startsWith(u8, version_str, ">=")) {
        constraint_type = .gte;
        version_str = version_str[2..];
    } else if (std.mem.startsWith(u8, version_str, "<=")) {
        constraint_type = .lte;
        version_str = version_str[2..];
    } else if (std.mem.startsWith(u8, version_str, ">")) {
        constraint_type = .gt;
        version_str = version_str[1..];
    } else if (std.mem.startsWith(u8, version_str, "<")) {
        constraint_type = .lt;
        version_str = version_str[1..];
    } else if (std.mem.startsWith(u8, version_str, "=")) {
        constraint_type = .exact;
        version_str = version_str[1..];
    }

    const version = try parseVersion(version_str);

    // Normalize partial / loose specifiers to ranges, matching npm/bun semantics.
    // Without this a bare major like "1" parses as exact 1.0.0 and never matches
    // the published 1.3.2, so deps such as `zlib.net@1`, `sourceware.org/bzip2@1`
    // and `libexpat.github.io@~2` resolve to "not found in registry".
    //   "1"     -> ^1    (>=1.0.0 <2.0.0)
    //   "1.2"   -> ~1.2  (>=1.2.0 <1.3.0)
    //   "1.2.3" -> exact
    //   "~2"    -> ^2    (a tilde with only a major behaves like caret: 2.x)
    const components = versionComponentCount(version_str);
    if (constraint_type == .exact) {
        if (components == 1) {
            constraint_type = .caret;
        } else if (components == 2) {
            constraint_type = .tilde;
        }
    } else if (constraint_type == .tilde and components == 1) {
        constraint_type = .caret;
    }

    return Constraint{
        .type = constraint_type,
        .major = version.major,
        .minor = version.minor,
        .patch = version.patch,
        .allows_prerelease = isPrerelease(version_str),
        .prerelease_number = prereleaseNumber(version_str),
        .raw_version = version_str,
    };
}

/// Number of dot-separated numeric components in a version string, ignoring a
/// leading `v` and any `-prerelease`/`+build` suffix. "1" -> 1, "1.2" -> 2,
/// "1.2.3-dev" -> 3.
fn versionComponentCount(version_str: []const u8) usize {
    var s = version_str;
    if (std.mem.startsWith(u8, s, "v")) s = s[1..];
    var core_len: usize = 0;
    while (core_len < s.len and (std.ascii.isDigit(s[core_len]) or s[core_len] == '.')) : (core_len += 1) {}
    const core = s[0..core_len];
    if (core.len == 0) return 0;
    var count: usize = 1;
    for (core) |c| {
        if (c == '.') count += 1;
    }
    return count;
}

/// True if a version string carries a pre-release tag (e.g. "2.10.0-RC1",
/// "1.2.0-beta.3"). Standard semver: a "-" after the major.minor.patch core marks
/// a pre-release. We treat the whole string as pre-release if any "-" appears after
/// an optional leading "v" — release versions never contain one.
pub fn isPrerelease(version_str: []const u8) bool {
    const v = if (std.mem.startsWith(u8, version_str, "v")) version_str[1..] else version_str;
    return std.mem.indexOfScalar(u8, v, '-') != null;
}

fn prereleaseNumber(version_str: []const u8) ?u64 {
    const marker = "-dev.";
    const start = (std.mem.indexOf(u8, version_str, marker) orelse return null) + marker.len;
    var end = start;
    while (end < version_str.len and std.ascii.isDigit(version_str[end])) : (end += 1) {}
    if (end == start) return null;
    return std.fmt.parseInt(u64, version_str[start..end], 10) catch null;
}

fn versionOrderAgainstConstraint(version_str: []const u8, version: Version, constraint: Constraint) std.math.Order {
    if (version.major != constraint.major) return std.math.order(version.major, constraint.major);
    if (version.minor != constraint.minor) return std.math.order(version.minor, constraint.minor);
    if (version.patch != constraint.patch) return std.math.order(version.patch, constraint.patch);

    if (!constraint.allows_prerelease) return .eq;
    if (!isPrerelease(version_str)) return .gt;
    return std.math.order(prereleaseNumber(version_str) orelse 0, constraint.prerelease_number orelse 0);
}

fn sameRegistryVersion(a: []const u8, b: []const u8) bool {
    const left = if (std.mem.startsWith(u8, a, "v")) a[1..] else a;
    const right = if (std.mem.startsWith(u8, b, "v")) b[1..] else b;
    if (left.len != right.len) return false;
    for (left, right) |l, r| {
        if (l == r) continue;
        if ((l == '+' or l == '_') and (r == '+' or r == '_')) continue;
        return false;
    }
    return true;
}

/// Check if a version satisfies a constraint
pub fn satisfiesConstraint(version_str: []const u8, constraint: Constraint) bool {
    const version = parseVersion(version_str) catch return false;

    // Stable constraints never opt into prereleases. A constraint which names a
    // prerelease channel, such as ^0.17.0-dev, may select matching builds.
    if (isPrerelease(version_str) and !constraint.allows_prerelease) return false;

    const order = versionOrderAgainstConstraint(version_str, version, constraint);

    return switch (constraint.type) {
        .exact => if (constraint.raw_version) |raw|
            if (std.mem.endsWith(u8, raw, "-dev"))
                version.major == constraint.major and version.minor == constraint.minor and version.patch == constraint.patch and
                    std.mem.startsWith(u8, version_str, raw) and version_str.len > raw.len and version_str[raw.len] == '.'
            else
                sameRegistryVersion(version_str, raw)
        else
            version.major == constraint.major and version.minor == constraint.minor and version.patch == constraint.patch,

        // ^1.2.3 := >=1.2.3 <2.0.0
        .caret => {
            if (order == .lt) return false;
            if (constraint.major == 0) {
                if (constraint.minor == 0) {
                    // ^0.0.x: only exact patch match (>=0.0.x <0.0.(x+1))
                    return version.major == 0 and version.minor == 0 and
                        version.patch == constraint.patch;
                }
                // ^0.x.y: same minor, patch >= constraint patch (>=0.x.y <0.(x+1).0)
                return version.major == 0 and
                    version.minor == constraint.minor and
                    version.patch >= constraint.patch;
            } else {
                // ^1.2.3 allows 1.x.x but not 2.0.0
                return version.major == constraint.major and
                    (version.minor > constraint.minor or
                        (version.minor == constraint.minor and version.patch >= constraint.patch));
            }
        },

        // ~1.2.3 := >=1.2.3 <1.3.0
        .tilde => order != .lt and version.major == constraint.major and
            version.minor == constraint.minor and
            version.patch >= constraint.patch,

        .gte => order != .lt,

        .lte => order != .gt,

        .gt => order == .gt,

        .lt => order == .lt,
    };
}

/// Check if a version string looks like a semver range (^, ~, >=, etc.)
pub fn isSemverRange(version: []const u8) bool {
    if (version.len == 0) return false;
    return version[0] == '^' or version[0] == '~' or version[0] == '>' or version[0] == '<' or version[0] == '=';
}

/// Find the best (highest) matching version from a list of version strings.
/// Returns the version string that best matches the constraint, or null.
pub fn findBestMatch(versions: []const []const u8, constraint_str: []const u8) ?[]const u8 {
    const constraint = parseConstraint(constraint_str) catch return null;

    var best: ?[]const u8 = null;
    var best_v: ?Version = null;

    for (versions) |ver| {
        if (!satisfiesConstraint(ver, constraint)) continue;
        const v = parseVersion(ver) catch continue;
        if (best_v) |bv| {
            // Pick higher version
            if (v.major > bv.major or
                (v.major == bv.major and v.minor > bv.minor) or
                (v.major == bv.major and v.minor == bv.minor and v.patch > bv.patch))
            {
                best = ver;
                best_v = v;
            }
        } else {
            best = ver;
            best_v = v;
        }
    }
    return best;
}

/// Find the best matching version from a JSON object's keys (e.g., npm versions object).
/// The keys are version strings like "1.2.3", "1.3.0", etc.
pub fn findBestMatchFromJsonKeys(
    versions_obj: std.json.ObjectMap,
    constraint_str: []const u8,
) ?[]const u8 {
    const constraint = parseConstraint(constraint_str) catch return null;

    var best: ?[]const u8 = null;
    var best_v: ?Version = null;

    var it = versions_obj.iterator();
    while (it.next()) |entry| {
        const ver = entry.key_ptr.*;
        if (!satisfiesConstraint(ver, constraint)) continue;
        const v = parseVersion(ver) catch continue;
        if (best_v) |bv| {
            if (v.major > bv.major or
                (v.major == bv.major and v.minor > bv.minor) or
                (v.major == bv.major and v.minor == bv.minor and v.patch > bv.patch))
            {
                best = ver;
                best_v = v;
            }
        } else {
            best = ver;
            best_v = v;
        }
    }
    return best;
}

/// Resolve a version constraint to the latest matching version for a package
/// Returns the resolved version string or null if no match found
pub fn resolveVersion(domain: []const u8, constraint_str: []const u8) ?[]const u8 {
    // Get package by domain
    const pkg = generated.getPackageByDomain(domain) orelse return null;

    // Handle "latest" as a special case - return the newest *stable* version.
    // `latest` must never resolve to a dev/prerelease build (npm semantics; this
    // also matches the TS resolver's latestFromPackageMetadata). Versions are
    // sorted newest-first, so the first non-prerelease is the latest stable.
    // e.g. for zig — whose catalog leads with 0.17.0-dev.956 — `latest` resolves
    // to 0.16.0, while `0.17.0-dev` still explicitly opts into the dev channel.
    if (std.mem.eql(u8, constraint_str, "latest")) {
        if (pkg.versions.len == 0) return null;
        for (pkg.versions) |version| {
            if (!isPrerelease(version)) return version;
        }
        // Package only ships prereleases — fall back to the newest so `latest`
        // still resolves to something.
        return pkg.versions[0];
    }

    // Parse constraint
    const constraint = parseConstraint(constraint_str) catch return null;

    // Versions are already sorted from newest to oldest
    // Return the first (newest) version that satisfies the constraint
    for (pkg.versions) |version| {
        if (satisfiesConstraint(version, constraint)) {
            return version;
        }
    }

    return null;
}

test "latest resolves to newest stable, not a prerelease" {
    // ziglang.org's catalog leads with dev builds (0.17.0-dev.*) followed by
    // stable 0.16.0 — `latest` must skip the dev builds (npm semantics).
    const latest = resolveVersion("ziglang.org", "latest") orelse return error.NoLatest;
    try std.testing.expect(!isPrerelease(latest));
    // …while the dev channel stays reachable when explicitly requested.
    const dev = resolveVersion("ziglang.org", "0.17.0-dev") orelse return error.NoDev;
    try std.testing.expect(isPrerelease(dev));
}

test "prerelease ranges select only the requested development line" {
    const development = try parseConstraint("^0.17.0-dev");
    try std.testing.expect(development.allows_prerelease);
    try std.testing.expect(satisfiesConstraint("0.17.0-dev.131+73c51c142", development));
    try std.testing.expect(satisfiesConstraint("0.17.0-dev.1441_d5181a9c9", development));
    try std.testing.expect(!satisfiesConstraint("0.18.0-dev.1_deadbeef", development));

    const bounded = try parseConstraint(">=0.17.0-dev.1417+20befa4e6");
    try std.testing.expect(!satisfiesConstraint("0.17.0-dev.131+73c51c142", bounded));
    try std.testing.expect(satisfiesConstraint("0.17.0-dev.1441_d5181a9c9", bounded));

    const stable = try parseConstraint("^0.17.0");
    try std.testing.expect(!satisfiesConstraint("0.17.0-dev.1441_d5181a9c9", stable));
}

test "exact prerelease keys retain build identity" {
    const exact = try parseConstraint("0.17.0-dev.1441+d5181a9c9");
    try std.testing.expect(satisfiesConstraint("0.17.0-dev.1441_d5181a9c9", exact));
    try std.testing.expect(!satisfiesConstraint("0.17.0-dev.1417_20befa4e6", exact));
}

test "parse version" {
    const v1 = try parseVersion("1.2.3");
    try std.testing.expectEqual(@as(u32, 1), v1.major);
    try std.testing.expectEqual(@as(u32, 2), v1.minor);
    try std.testing.expectEqual(@as(u32, 3), v1.patch);

    const v2 = try parseVersion("v1.2.3");
    try std.testing.expectEqual(@as(u32, 1), v2.major);

    const v3 = try parseVersion("1.2.3-beta");
    try std.testing.expectEqual(@as(u32, 1), v3.major);
    try std.testing.expectEqual(@as(u32, 2), v3.minor);
    try std.testing.expectEqual(@as(u32, 3), v3.patch);
}

test "parse constraint" {
    const c1 = try parseConstraint("^1.2.3");
    try std.testing.expectEqual(ConstraintType.caret, c1.type);
    try std.testing.expectEqual(@as(u32, 1), c1.major);

    const c2 = try parseConstraint("~1.2.0");
    try std.testing.expectEqual(ConstraintType.tilde, c2.type);

    const c3 = try parseConstraint(">=1.0.0");
    try std.testing.expectEqual(ConstraintType.gte, c3.type);
}

test "satisfies constraint - exact" {
    const c = Constraint{ .type = .exact, .major = 1, .minor = 2, .patch = 3 };
    try std.testing.expect(satisfiesConstraint("1.2.3", c));
    try std.testing.expect(!satisfiesConstraint("1.2.4", c));
}

test "satisfies constraint - caret" {
    const c = Constraint{ .type = .caret, .major = 1, .minor = 2, .patch = 16 };

    // Should allow 1.2.16, 1.2.17, ..., 1.3.0, 1.99.99
    try std.testing.expect(satisfiesConstraint("1.2.16", c));
    try std.testing.expect(satisfiesConstraint("1.2.23", c));
    try std.testing.expect(satisfiesConstraint("1.3.0", c));
    try std.testing.expect(satisfiesConstraint("1.99.99", c));

    // Should NOT allow 2.0.0 or 1.2.15
    try std.testing.expect(!satisfiesConstraint("2.0.0", c));
    try std.testing.expect(!satisfiesConstraint("1.2.15", c));
    try std.testing.expect(!satisfiesConstraint("1.1.0", c));
}

test "satisfies constraint - tilde" {
    const c = Constraint{ .type = .tilde, .major = 1, .minor = 2, .patch = 0 };

    // Should allow 1.2.0, 1.2.1, ..., 1.2.99
    try std.testing.expect(satisfiesConstraint("1.2.0", c));
    try std.testing.expect(satisfiesConstraint("1.2.23", c));

    // Should NOT allow 1.3.0
    try std.testing.expect(!satisfiesConstraint("1.3.0", c));
}

test "parse constraint - loose/partial specifiers resolve to ranges" {
    // Bare major "1" behaves like ^1 (1.x), so 1.3.2 satisfies it.
    const c1 = try parseConstraint("1");
    try std.testing.expectEqual(ConstraintType.caret, c1.type);
    try std.testing.expect(satisfiesConstraint("1.3.2", c1));
    try std.testing.expect(satisfiesConstraint("1.0.8", c1));
    try std.testing.expect(!satisfiesConstraint("2.0.0", c1));

    // "1.2" behaves like ~1.2 (1.2.x).
    const c2 = try parseConstraint("1.2");
    try std.testing.expectEqual(ConstraintType.tilde, c2.type);
    try std.testing.expect(satisfiesConstraint("1.2.13", c2));
    try std.testing.expect(!satisfiesConstraint("1.3.0", c2));

    // "~2" (tilde, major only) behaves like ^2 (2.x), so 2.7.5 satisfies it.
    const c3 = try parseConstraint("~2");
    try std.testing.expectEqual(ConstraintType.caret, c3.type);
    try std.testing.expect(satisfiesConstraint("2.7.5", c3));
    try std.testing.expect(!satisfiesConstraint("3.0.0", c3));

    // A full "1.2.3" stays exact.
    const c4 = try parseConstraint("1.2.3");
    try std.testing.expectEqual(ConstraintType.exact, c4.type);
    try std.testing.expect(!satisfiesConstraint("1.2.4", c4));
}

test "resolve version - bun ^1.2.16" {
    const resolved = resolveVersion("bun.sh", "^1.2.16");
    if (resolved) |version| {
        // Should resolve to latest 1.x version (1.2.23 or higher)
        const v = try parseVersion(version);
        try std.testing.expectEqual(@as(u32, 1), v.major);
        try std.testing.expect(v.minor >= 2);
        if (v.minor == 2) {
            try std.testing.expect(v.patch >= 16);
        }
    } else {
        try std.testing.expect(false); // Should find a version
    }
}

test "resolve version - exact match" {
    const resolved = resolveVersion("bun.sh", "1.2.20");
    if (resolved) |version| {
        try std.testing.expectEqualStrings("1.2.20", version);
    } else {
        try std.testing.expect(false);
    }
}

test "satisfies constraint - gte" {
    const c = Constraint{ .type = .gte, .major = 1, .minor = 2, .patch = 0 };
    try std.testing.expect(satisfiesConstraint("1.2.0", c));
    try std.testing.expect(satisfiesConstraint("1.2.1", c));
    try std.testing.expect(satisfiesConstraint("2.0.0", c));
    try std.testing.expect(!satisfiesConstraint("1.1.9", c));
    try std.testing.expect(!satisfiesConstraint("0.9.0", c));
}

test "satisfies constraint - lt" {
    const c = Constraint{ .type = .lt, .major = 2, .minor = 0, .patch = 0 };
    try std.testing.expect(satisfiesConstraint("1.9.9", c));
    try std.testing.expect(satisfiesConstraint("1.0.0", c));
    try std.testing.expect(!satisfiesConstraint("2.0.0", c));
    try std.testing.expect(!satisfiesConstraint("3.0.0", c));
}

test "satisfies constraint - gt" {
    const c = Constraint{ .type = .gt, .major = 1, .minor = 0, .patch = 0 };
    try std.testing.expect(satisfiesConstraint("1.0.1", c));
    try std.testing.expect(satisfiesConstraint("2.0.0", c));
    try std.testing.expect(!satisfiesConstraint("1.0.0", c));
    try std.testing.expect(!satisfiesConstraint("0.9.9", c));
}

test "satisfies constraint - lte" {
    const c = Constraint{ .type = .lte, .major = 1, .minor = 5, .patch = 0 };
    try std.testing.expect(satisfiesConstraint("1.5.0", c));
    try std.testing.expect(satisfiesConstraint("1.4.9", c));
    try std.testing.expect(satisfiesConstraint("0.0.1", c));
    try std.testing.expect(!satisfiesConstraint("1.5.1", c));
    try std.testing.expect(!satisfiesConstraint("2.0.0", c));
}

test "isSemverRange" {
    try std.testing.expect(isSemverRange("^1.0.0"));
    try std.testing.expect(isSemverRange("~1.0.0"));
    try std.testing.expect(isSemverRange(">=1.0.0"));
    try std.testing.expect(isSemverRange(">1.0.0"));
    try std.testing.expect(isSemverRange("<2.0.0"));
    try std.testing.expect(isSemverRange("<=2.0.0"));
    try std.testing.expect(isSemverRange("=1.0.0"));
    try std.testing.expect(!isSemverRange("1.0.0"));
    try std.testing.expect(!isSemverRange("latest"));
    try std.testing.expect(!isSemverRange(""));
}

test "findBestMatch" {
    const versions = [_][]const u8{ "1.0.0", "1.1.0", "1.2.0", "2.0.0" };
    const result = findBestMatch(&versions, "^1.0.0");
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("1.2.0", result.?);
}

test "findBestMatch - no match" {
    const versions = [_][]const u8{ "1.0.0", "1.1.0" };
    const result = findBestMatch(&versions, "^2.0.0");
    try std.testing.expect(result == null);
}

test "parse version with v prefix" {
    const v = try parseVersion("v2.3.4");
    try std.testing.expectEqual(@as(u32, 2), v.major);
    try std.testing.expectEqual(@as(u32, 3), v.minor);
    try std.testing.expectEqual(@as(u32, 4), v.patch);
}

test "parse constraint with = prefix" {
    const c = try parseConstraint("=1.5.0");
    try std.testing.expectEqual(ConstraintType.exact, c.type);
    try std.testing.expectEqual(@as(u32, 1), c.major);
    try std.testing.expectEqual(@as(u32, 5), c.minor);
    try std.testing.expectEqual(@as(u32, 0), c.patch);
}

test "caret ^0.1.2 matches 0.1.x but not 0.2.0" {
    const c = try parseConstraint("^0.1.2");
    try std.testing.expect(satisfiesConstraint("0.1.2", c));
    try std.testing.expect(satisfiesConstraint("0.1.3", c));
    try std.testing.expect(satisfiesConstraint("0.1.99", c));
    try std.testing.expect(!satisfiesConstraint("0.2.0", c));
    try std.testing.expect(!satisfiesConstraint("0.1.1", c));
    try std.testing.expect(!satisfiesConstraint("1.0.0", c));
}

test "tilde ~1.2.3 matches 1.2.x but not 1.3.0" {
    const c = try parseConstraint("~1.2.3");
    try std.testing.expect(satisfiesConstraint("1.2.3", c));
    try std.testing.expect(satisfiesConstraint("1.2.4", c));
    try std.testing.expect(satisfiesConstraint("1.2.99", c));
    try std.testing.expect(!satisfiesConstraint("1.3.0", c));
    try std.testing.expect(!satisfiesConstraint("1.2.2", c));
    try std.testing.expect(!satisfiesConstraint("2.0.0", c));
}

test "caret constraint with 0.x" {
    // ^0.2.3 should only allow 0.2.x where x >= 3
    const c = Constraint{ .type = .caret, .major = 0, .minor = 2, .patch = 3 };
    try std.testing.expect(satisfiesConstraint("0.2.3", c));
    try std.testing.expect(satisfiesConstraint("0.2.4", c));
    try std.testing.expect(!satisfiesConstraint("0.3.0", c));
    try std.testing.expect(!satisfiesConstraint("0.2.2", c));
    try std.testing.expect(!satisfiesConstraint("1.0.0", c));
}
