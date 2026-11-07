//! Native alias views for install preflight and lock regeneration. Nothing in
//! this module writes a committed file or changes a selected package version.
const std = @import("std");
const types = @import("types.zig");
const writer = @import("lockfile.zig");
const identity = @import("native_identity.zig");

pub fn isNative(entry: types.LockfileEntry) bool {
    return entry.invalid_source_json == null and identity.isNative(entry.source);
}

pub fn read(allocator: std.mem.Allocator, path: []const u8) !types.Lockfile {
    var lock = try writer.readLockfile(allocator, path);
    errdefer lock.deinit(allocator);
    lock.native_identity_changed = try canonicalize(allocator, &lock);
    return lock;
}

/// Retain the complete metadata of an unchanged native pin. Fresh versions
/// get fresh records; no metadata from a different provider is adopted.
pub fn selectedEntry(allocator: std.mem.Allocator, lock: *const types.Lockfile, name: []const u8, version: []const u8, integrity: ?[]const u8) !types.LockfileEntry {
    var iterator = lock.packages.iterator();
    while (iterator.next()) |entry| {
        const previous = entry.value_ptr;
        if (!isNative(previous.*) or !identity.same(previous.name, name) or !std.mem.eql(u8, previous.version, version)) continue;
        var selected = try previous.clone(allocator);
        errdefer selected.deinit(allocator);
        const domain = identity.canonical(name);
        const owned_name = try allocator.dupe(u8, domain);
        allocator.free(selected.name);
        selected.name = owned_name;
        if (selected.resolved) |reference| {
            if (identity.registryReferenceMatches(reference, name, version)) {
                const owned_reference = try std.fmt.allocPrint(allocator, "registry:{s}@{s}", .{ domain, version });
                allocator.free(reference);
                selected.resolved = owned_reference;
            }
        }
        if (selected.source == .ziglang) selected.source = .pantry;
        if (integrity) |value| {
            const owned = try allocator.dupe(u8, value);
            if (selected.integrity) |old| allocator.free(old);
            selected.integrity = owned;
        }
        return selected;
    }
    var selected = types.LockfileEntry{ .name = "", .version = "", .source = .pantry };
    errdefer selected.deinit(allocator);
    selected.name = try allocator.dupe(u8, identity.canonical(name));
    selected.version = try allocator.dupe(u8, version);
    selected.resolved = try std.fmt.allocPrint(allocator, "registry:{s}@{s}", .{ selected.name, version });
    if (integrity) |value| selected.integrity = try allocator.dupe(u8, value);
    return selected;
}

/// Canonicalize only families actually containing native aliases. All fields
/// remain owned by this view, including arbitrary URLs and foreign versions.
/// A duplicate identity is collapsible only if every metadata field agrees.
/// On error the partially consumed view remains valid for deinit.
pub fn canonicalize(allocator: std.mem.Allocator, lock: *types.Lockfile) !bool {
    var families = std.StringHashMap(void).init(allocator);
    defer {
        var keys = families.keyIterator();
        while (keys.next()) |key| allocator.free(key.*);
        families.deinit();
    }
    var iterator = lock.packages.iterator();
    while (iterator.next()) |entry| {
        const package = entry.value_ptr.*;
        if (!isNative(package)) continue;
        if (package.source == .ziglang or identity.hasAlias(entry.key_ptr.*, package.name, package.version, package.resolved)) {
            const domain = identity.canonical(package.name);
            if (!families.contains(domain)) {
                const owned = try allocator.dupe(u8, domain);
                errdefer allocator.free(owned);
                try families.put(owned, {});
            }
        }
    }
    if (families.count() == 0) return false;

    var normalized = std.StringHashMap(types.LockfileEntry).init(allocator);
    errdefer {
        var owned = normalized.iterator();
        while (owned.next()) |entry| {
            allocator.free(entry.key_ptr.*);
            entry.value_ptr.deinit(allocator);
        }
        normalized.deinit();
    }
    try normalized.ensureUnusedCapacity(lock.packages.count());
    while (lock.packages.count() != 0) {
        var remaining = lock.packages.iterator();
        const removed = lock.packages.fetchRemove(remaining.next().?.key_ptr.*).?;
        var key = removed.key;
        var package = removed.value;
        var transferred = false;
        errdefer if (!transferred) {
            allocator.free(key);
            package.deinit(allocator);
        };
        const domain = identity.canonical(package.name);
        if (isNative(package) and families.contains(domain)) {
            const canonical_name = try allocator.dupe(u8, domain);
            errdefer allocator.free(canonical_name);
            const canonical_key = try std.fmt.allocPrint(allocator, "{s}@{s}", .{ domain, package.version });
            errdefer allocator.free(canonical_key);
            const canonical_resolved = if (package.resolved) |reference|
                if (identity.registryReferenceMatches(reference, package.name, package.version))
                    try std.fmt.allocPrint(allocator, "registry:{s}@{s}", .{ domain, package.version })
                else
                    null
            else
                null;
            allocator.free(package.name);
            package.name = canonical_name;
            allocator.free(key);
            key = canonical_key;
            if (canonical_resolved) |reference| {
                allocator.free(package.resolved.?);
                package.resolved = reference;
            }
            if (package.source == .ziglang) package.source = .pantry;
        }
        if (normalized.get(key)) |previous| {
            if (isNative(previous) != isNative(package)) return error.NativeSourceConflict;
            if (!writer.entriesEqual(previous, package)) return error.ConflictingNativeLockMetadata;
            allocator.free(key);
            package.deinit(allocator);
        } else {
            normalized.putAssumeCapacity(key, package);
        }
        transferred = true;
    }
    lock.packages.deinit();
    lock.packages = normalized;
    return true;
}

// Pure schema fixtures, separate from normally generated public CLI locks.
fn readFixture(allocator: std.mem.Allocator, json: []const u8) !types.Lockfile {
    const io_helper = @import("../io_helper.zig");
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    try directory.dir.writeFile(io_helper.io, .{ .sub_path = "pantry.lock", .data = json });
    const path = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}/pantry.lock", .{directory.sub_path});
    defer allocator.free(path);
    var view = try read(allocator, path);
    errdefer view.deinit(allocator);
    const unchanged = try directory.dir.readFileAlloc(io_helper.io, "pantry.lock", allocator, .limited(8192));
    defer allocator.free(unchanged);
    try std.testing.expectEqualStrings(json, unchanged);
    return view;
}

test "native alias views retain metadata and foreign versions without changing committed bytes" {
    const allocator = std.testing.allocator;
    var view = try readFixture(allocator,
        \\{"version":"1.0.0","lockfileVersion":2,"workspaces":{"":{"name":"fixture","system":{"bun.sh":"^1.4"}}},"packages":{
        \\ "bun.sh@1.4.3":{"name":"bun.sh","version":"1.4.3","source":"pantry","resolved":"registry:bun.sh@1.4.3","url":"https://opaque.fixture/archive","integrity":"sha512-kept","dependencies":{"child":"^2"},"peerDependencies":{"peer":"^1"},"bin":{"tool":"bin/tool"},"optionalPeers":["peer"]},
        \\ "bun.com@1.4.3":{"name":"bun.com","version":"1.4.3","source":"pantry","resolved":"registry:bun.com@1.4.3","url":"https://opaque.fixture/archive","integrity":"sha512-kept","dependencies":{"child":"^2"},"peerDependencies":{"peer":"^1"},"bin":{"tool":"bin/tool"},"optionalPeers":["peer"]},
        \\ "bun.sh@1.3.14":{"name":"bun.sh","version":"1.3.14","source":"pantry","resolved":"registry:bun.sh@1.3.14","integrity":"sha512-foreign"},
        \\ "npm-pin":{"name":"bun.sh","version":"1.4.4","source":"npm","integrity":"sha512-npm"},
        \\ "invalid-pin":{"name":"bun.sh","version":"9.0.0","source":false}
        \\}}
    );
    defer view.deinit(allocator);
    try std.testing.expect(view.native_identity_changed);
    try std.testing.expectEqual(@as(u32, 4), view.packages.count());
    const selected = view.packages.get("bun.com@1.4.3").?;
    try std.testing.expectEqualStrings("bun.com", selected.name);
    try std.testing.expectEqualStrings("registry:bun.com@1.4.3", selected.resolved.?);
    try std.testing.expectEqualStrings("https://opaque.fixture/archive", selected.url.?);
    try std.testing.expectEqualStrings("sha512-kept", selected.integrity.?);
    try std.testing.expectEqualStrings("^2", selected.dependencies.?.get("child").?);
    try std.testing.expectEqualStrings("^1", selected.peer_dependencies.?.get("peer").?);
    try std.testing.expectEqualStrings("bin/tool", selected.bin.?.get("tool").?);
    try std.testing.expect(selected.optional_peers.?.get("peer").?);
    try std.testing.expectEqualStrings("sha512-foreign", view.packages.get("bun.com@1.3.14").?.integrity.?);
    try std.testing.expectEqualStrings("^1.4", view.workspaces.get("").?.system.?.get("bun.sh").?);
    try std.testing.expectEqual(types.PackageSource.npm, view.packages.get("npm-pin").?.source);
    try std.testing.expectEqualStrings("false", view.packages.get("invalid-pin").?.invalid_source_json.?);
    try std.testing.expect(!isNative(view.packages.get("invalid-pin").?));

    var copy = try selected.clone(allocator);
    defer copy.deinit(allocator);
    try std.testing.expect(writer.entriesEqual(selected, copy));
    copy.optional_peers.?.getPtr("peer").?.* = false;
    try std.testing.expect(!writer.entriesEqual(selected, copy));
    try std.testing.expect(selected.optional_peers.?.get("peer").?);

    const io_helper = @import("../io_helper.zig");
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const path = try std.fmt.allocPrint(allocator, ".zig-cache/tmp/{s}/roundtrip.lock", .{directory.sub_path});
    defer allocator.free(path);
    try writer.writeLockfile(allocator, &view, path);
    var roundtrip = try read(allocator, path);
    defer roundtrip.deinit(allocator);
    try std.testing.expect(writer.lockfilesEqual(&view, &roundtrip));
    const serialized = try directory.dir.readFileAlloc(io_helper.io, "roundtrip.lock", allocator, .limited(8192));
    defer allocator.free(serialized);
    try std.testing.expect(std.mem.indexOf(u8, serialized, "\"source\": false") != null);

    var fresh = try selectedEntry(allocator, &view, "bun.sh", "1.4.4", null);
    defer fresh.deinit(allocator);
    try std.testing.expectEqualStrings("bun.com", fresh.name);
    try std.testing.expect(fresh.integrity == null);
    try std.testing.expect(fresh.url == null);
}

test "native alias metadata disagreements are rejected rather than selected by iteration order" {
    const allocator = std.testing.allocator;
    const changes = [_][]const u8{
        \\,"resolved":"https://other.fixture/archive"
        ,
        \\,"resolved":"registry:bun.sh@1.4.3","url":"https://other.fixture/archive"
        ,
        \\,"resolved":"registry:bun.sh@1.4.3","integrity":"sha512-other"
        ,
        \\,"resolved":"registry:bun.sh@1.4.3","dependencies":{"child":"^2"}
        ,
        \\,"resolved":"registry:bun.sh@1.4.3","peerDependencies":{"peer":"^1"}
        ,
        \\,"resolved":"registry:bun.sh@1.4.3","bin":{"tool":"bin/tool"}
        ,
        \\,"resolved":"registry:bun.sh@1.4.3","optionalPeers":["peer"]
        ,
    };
    for (changes) |change| {
        const json = try std.mem.concat(allocator, u8, &.{
            \\{"version":"1.0.0","workspaces":{},"packages":{"alias":{"name":"bun.sh","version":"1.4.3","source":"pantry"
            ,
            change,
            \\},"canonical":{"name":"bun.com","version":"1.4.3","source":"pantry","resolved":"registry:bun.com@1.4.3"}}}
            ,
        });
        defer allocator.free(json);
        try std.testing.expectError(error.ConflictingNativeLockMetadata, readFixture(allocator, json));
    }
}
