//! Desktop scope follows the compiled catalog, so a bare app install works
//! without changing how ordinary project dependencies are installed.
const std = @import("std");
const generated = @import("../../../packages/generated.zig");
const helpers = @import("helpers.zig");

pub fn isDesktop(spec: []const u8, kind_override: ?[]const u8) bool {
    if (kind_override) |kind| return std.mem.eql(u8, kind, "app") or std.mem.eql(u8, kind, "font");
    const name = helpers.splitPackageSpec(spec).name;
    const package = generated.getPackageByName(name) orelse return false;
    return package.kind == .app or package.kind == .font;
}

test "desktop routing infers catalog aliases, names and pinned versions" {
    const testing = std.testing;
    try testing.expect(isDesktop("launchpad", null));
    try testing.expect(isDesktop("Launchpad", null));
    try testing.expect(isDesktop("github.com/stacksjs/launchpad@1.0.3", null));
    try testing.expect(isDesktop("raycast", null));
    try testing.expect(isDesktop("fira-code", null));
    try testing.expect(!isDesktop("gh", null));
    try testing.expect(!isDesktop("abseil.io", null));
    try testing.expect(!isDesktop("@stacksjs/stx@0.2.727", null));
    try testing.expect(!isDesktop("not-in-the-catalog", null));
}

test "an explicit kind retains control of ambiguous and future packages" {
    try std.testing.expect(!isDesktop("launchpad", "cli"));
    try std.testing.expect(!isDesktop("launchpad", "library"));
    try std.testing.expect(isDesktop("new-app.example", "app"));
    try std.testing.expect(isDesktop("new-font.example", "font"));
}
