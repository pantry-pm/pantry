//! Decisions `pantry publish` makes about a monorepo release as a whole,
//! rather than about one upload: which packages must wait because something
//! they need did not make it, and what to say when npm has no such scope.
//!
//! Kept apart from package.zig, as publish_conflict.zig is, so the tests
//! below actually run (test_registry_root.zig imports this file).

const std = @import("std");

/// The sections whose packages an install of the published package fetches.
/// devDependencies are not installed by consumers, so a sibling that only
/// appears there holds nothing back.
const install_sections = [_][]const u8{ "dependencies", "peerDependencies", "optionalDependencies" };

/// The first dependency of the manifest in `content` that is one of
/// `failed`: a workspace sibling that did not publish in this run.
///
/// Publishing a package anyway would put a version on npm that cannot be
/// installed — its dependency's version is not there — and npm versions can't
/// be replaced, only superseded. Holding it back costs nothing: the next run,
/// once the sibling is fixed, publishes both.
///
/// A manifest that can't be parsed holds nothing back; the publish itself will
/// say what is wrong with it.
pub fn heldBackBy(allocator: std.mem.Allocator, content: []const u8, failed: []const []const u8) ?[]const u8 {
    if (failed.len == 0) return null;
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, content, .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;
    for (install_sections) |section| {
        const deps = parsed.value.object.get(section) orelse continue;
        if (deps != .object) continue;
        var it = deps.object.iterator();
        while (it.next()) |entry| {
            // Return the caller's own slice, which outlives the parse.
            for (failed) |name| {
                if (std.mem.eql(u8, name, entry.key_ptr.*)) return name;
            }
        }
    }
    return null;
}

/// The scope npm says does not exist, for a scoped package rejected with
/// "Scope not found": `@ts-maps` for `@ts-maps/react`.
///
/// npm answers a publish to an organisation that was never created with a
/// bare 404, which reads like a token problem. It isn't one, and no token can
/// fix it: the org has to exist, and the publishing account has to belong to
/// it.
pub fn missingScope(package_name: []const u8, message: ?[]const u8) ?[]const u8 {
    if (package_name.len < 2 or package_name[0] != '@') return null;
    const msg = message orelse return null;
    if (std.ascii.findIgnoreCase(msg, "scope not found") == null) return null;
    const slash = std.mem.indexOfScalar(u8, package_name, '/') orelse return null;
    return package_name[0..slash];
}

test "a package waits for a sibling it installs that failed" {
    const a = std.testing.allocator;
    const manifest =
        \\{ "name": "ts-maps-nuxt", "dependencies": { "@ts-maps/vue": "workspace:*", "ts-maps": "workspace:*" } }
    ;
    try std.testing.expectEqualStrings("@ts-maps/vue", heldBackBy(a, manifest, &.{ "@ts-maps/react", "@ts-maps/vue" }).?);
    try std.testing.expect(heldBackBy(a, manifest, &.{"@ts-maps/react"}) == null);
    try std.testing.expect(heldBackBy(a, manifest, &.{}) == null);
}

test "peer and optional dependencies hold a package back; dev dependencies don't" {
    const a = std.testing.allocator;
    try std.testing.expect(heldBackBy(a,
        \\{ "peerDependencies": { "core": "^1.0.0" } }
    , &.{"core"}) != null);
    try std.testing.expect(heldBackBy(a,
        \\{ "optionalDependencies": { "core": "^1.0.0" } }
    , &.{"core"}) != null);
    try std.testing.expect(heldBackBy(a,
        \\{ "devDependencies": { "core": "workspace:*" } }
    , &.{"core"}) == null);
}

test "a manifest that can't be read holds nothing back" {
    try std.testing.expect(heldBackBy(std.testing.allocator, "{ not json", &.{"core"}) == null);
}

test "a missing scope is named from npm's message" {
    try std.testing.expectEqualStrings("@ts-maps", missingScope("@ts-maps/react", "404 Not Found: Scope not found").?);
    try std.testing.expectEqualStrings("@ts-maps", missingScope("@ts-maps/react", "scope not found").?);
    try std.testing.expect(missingScope("ts-maps", "Scope not found") == null);
    try std.testing.expect(missingScope("@ts-maps/react", "Not found") == null);
    try std.testing.expect(missingScope("@ts-maps/react", null) == null);
}
