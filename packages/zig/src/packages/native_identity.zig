//! Catalog identity for dependencies already classified as native packages.
//! Never use native aliases to classify or rename npm, Git or pinned providers.
const std = @import("std");
const generated = @import("generated.zig");
const PackageSource = @import("types.zig").PackageSource;

pub fn isNative(source: PackageSource) bool {
    return source == .pantry or source == .ziglang;
}

/// Catalog domains are authoritative. Registry-only domains stay unchanged.
pub fn canonical(name: []const u8) []const u8 {
    const package = generated.getPackageByDomain(name) orelse generated.getPackageByName(name) orelse return name;
    return package.domain;
}

pub fn same(first: []const u8, second: []const u8) bool {
    return std.mem.eql(u8, canonical(first), canonical(second));
}

/// A concrete identity, never a range key or an arbitrary retained-key prefix.
pub fn keyMatches(key: []const u8, name: []const u8, version: []const u8) bool {
    const at = std.mem.lastIndexOfScalar(u8, key, '@') orelse return false;
    return std.mem.eql(u8, key[at + 1 ..], version) and same(key[0..at], name);
}

pub fn registryReferenceMatches(reference: []const u8, name: []const u8, version: []const u8) bool {
    const prefix = "registry:";
    return std.mem.startsWith(u8, reference, prefix) and keyMatches(reference[prefix.len..], name, version);
}

pub fn hasAlias(key: []const u8, name: []const u8, version: []const u8, resolved: ?[]const u8) bool {
    const domain = canonical(name);
    if (!std.mem.eql(u8, domain, name)) return true;
    if (keyMatches(key, name, version)) {
        const at = std.mem.lastIndexOfScalar(u8, key, '@').?;
        if (!std.mem.eql(u8, key[0..at], domain)) return true;
    }
    if (resolved) |reference| {
        if (registryReferenceMatches(reference, name, version)) {
            const at = std.mem.lastIndexOfScalar(u8, reference, '@').?;
            if (!std.mem.eql(u8, reference["registry:".len..at], domain)) return true;
        }
    }
    return false;
}

test "native catalog identity recognizes aliases without guessing registry-only domains" {
    try std.testing.expectEqualStrings("bun.com", canonical("bun"));
    try std.testing.expectEqualStrings("bun.com", canonical("bun.sh"));
    try std.testing.expectEqualStrings("bun.com", canonical("bun.com"));
    try std.testing.expectEqualStrings("ziglang.org", canonical("zig"));
    try std.testing.expectEqualStrings("registry-only.fixture.test", canonical("registry-only.fixture.test"));
    try std.testing.expect(keyMatches("bun.sh@1.4.3", "bun.com", "1.4.3"));
    try std.testing.expect(!keyMatches("bun.sh@^1", "bun.com", "1.4.3"));
    try std.testing.expect(!keyMatches("retained/bun.sh@1.4.3", "bun.com", "1.4.3"));
    try std.testing.expect(registryReferenceMatches("registry:bun.sh@1.4.3", "bun.com", "1.4.3"));
    try std.testing.expect(!registryReferenceMatches("https://fixture.test/bun.sh@1.4.3", "bun.com", "1.4.3"));
}
