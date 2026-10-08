//! The CA bundle for installed OpenSSLs.
//!
//! A pkgx-layout OpenSSL looks for its certificates beside its own library,
//! `<prefix>/ssl/cert.pem` (props/x509_def.c.diff), so it works wherever the
//! tree is installed. The artifact ships no bundle: that is curl.se/ca-certs,
//! a package of its own. Without the link, everything built on that OpenSSL
//! (python.org's `ssl`, and so yt-dlp, pip and urllib) failed every HTTPS
//! request with CERTIFICATE_VERIFY_FAILED. So after either is installed, each
//! OpenSSL that has no `ssl/cert.pem` gets a relative link to the newest
//! installed bundle, and one left dangling by a removed bundle is repointed.

const std = @import("std");
const io_helper = @import("../io_helper.zig");

/// Numeric parts of a version directory name, `v2026.3.19` -> {2026, 3, 19}.
fn versionParts(name: []const u8, out: *[4]u32) ?usize {
    if (name.len < 2 or name[0] != 'v' or !std.ascii.isDigit(name[1])) return null;
    var it = std.mem.splitScalar(u8, name[1..], '.');
    var n: usize = 0;
    while (it.next()) |part| {
        if (n == out.len) break;
        out[n] = std.fmt.parseInt(u32, part, 10) catch return null;
        n += 1;
    }
    return n;
}

fn newer(a: []const u8, b: []const u8) bool {
    var pa: [4]u32 = .{ 0, 0, 0, 0 };
    var pb: [4]u32 = .{ 0, 0, 0, 0 };
    _ = versionParts(a, &pa) orelse return false;
    _ = versionParts(b, &pb) orelse return true;
    for (pa, pb) |x, y| if (x != y) return x > y;
    return false;
}

/// The newest `v<x>.<y>...` directory of `dir` holding `ssl/cert.pem`, written into `out`.
fn newestBundle(allocator: std.mem.Allocator, dir: []const u8, out: []u8) ?[]const u8 {
    var handle = io_helper.openDirAbsoluteForIteration(dir) catch return null;
    defer handle.close();
    var best: ?[]const u8 = null;
    var it = handle.iterate();
    while (it.next() catch null) |entry| {
        // Real version directories only; `v2026` is a link to one of them.
        if (entry.kind != .directory or std.mem.indexOfScalar(u8, entry.name, '.') == null) continue;
        const pem = std.fmt.allocPrint(allocator, "{s}/{s}/ssl/cert.pem", .{ dir, entry.name }) catch continue;
        defer allocator.free(pem);
        io_helper.accessAbsolute(pem, .{}) catch continue;
        if (best == null or newer(entry.name, best.?)) {
            if (entry.name.len > out.len) continue;
            @memcpy(out[0..entry.name.len], entry.name);
            best = out[0..entry.name.len];
        }
    }
    return best;
}

/// Link every OpenSSL under `root` (the directory domains are installed in:
/// `<global>/packages` or a project's `pantry`) to the newest CA bundle there.
pub fn linkBundles(allocator: std.mem.Allocator, root: []const u8) void {
    const ca_dir = std.fmt.allocPrint(allocator, "{s}/curl.se/ca-certs", .{root}) catch return;
    defer allocator.free(ca_dir);
    var name_buf: [256]u8 = undefined;
    const bundle = newestBundle(allocator, ca_dir, &name_buf) orelse return;
    const target = std.fmt.allocPrint(allocator, "../../../curl.se/ca-certs/{s}/ssl/cert.pem", .{bundle}) catch return;
    defer allocator.free(target);

    const ssl_root = std.fmt.allocPrint(allocator, "{s}/openssl.org", .{root}) catch return;
    defer allocator.free(ssl_root);
    var dir = io_helper.openDirAbsoluteForIteration(ssl_root) catch return;
    defer dir.close();
    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (entry.kind != .directory) continue;
        const ssl_dir = std.fmt.allocPrint(allocator, "{s}/{s}/ssl", .{ ssl_root, entry.name }) catch continue;
        defer allocator.free(ssl_dir);
        io_helper.accessAbsolute(ssl_dir, .{}) catch continue;
        const pem = std.fmt.allocPrint(allocator, "{s}/cert.pem", .{ssl_dir}) catch continue;
        defer allocator.free(pem);
        // Present and readable (a bundle of its own, or a live link): leave it.
        if (io_helper.accessAbsolute(pem, .{})) |_| continue else |_| {}
        // Missing, or a link whose bundle is gone.
        io_helper.deleteFile(pem) catch {};
        io_helper.symLink(target, pem) catch {};
    }
}

/// The directory a package's domain sits in, from where it was installed:
/// `<root>/<domain>/v<version>` -> `<root>`.
pub fn treeRootOf(install_path: []const u8, domain: []const u8) ?[]const u8 {
    var root = std.fs.path.dirname(install_path) orelse return null;
    var segments = std.mem.countScalar(u8, domain, '/') + 1;
    while (segments > 0) : (segments -= 1) root = std.fs.path.dirname(root) orelse return null;
    return root;
}

test "an OpenSSL without a bundle is linked to the newest installed one" {
    const testing = std.testing;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];

    var buf: [std.fs.max_path_bytes]u8 = undefined;
    for ([_][]const u8{ "v2025.12.2", "v2026.3.19" }) |version| {
        const ssl = try std.fmt.bufPrint(&buf, "{s}/curl.se/ca-certs/{s}/ssl", .{ root, version });
        try io_helper.makePath(ssl);
        var pem_buf: [std.fs.max_path_bytes]u8 = undefined;
        io_helper.closeFile(try io_helper.createFileAbsolute(try std.fmt.bufPrint(&pem_buf, "{s}/cert.pem", .{ssl}), .{}));
    }
    const openssl = try std.fmt.bufPrint(&buf, "{s}/openssl.org/v1.1.1w/ssl", .{root});
    try io_helper.makePath(openssl);

    linkBundles(testing.allocator, root);

    var pem_buf: [std.fs.max_path_bytes]u8 = undefined;
    const pem = try std.fmt.bufPrint(&pem_buf, "{s}/openssl.org/v1.1.1w/ssl/cert.pem", .{root});
    try io_helper.accessAbsolute(pem, .{});
    var link_buf: [std.fs.max_path_bytes]u8 = undefined;
    try testing.expectEqualStrings("../../../curl.se/ca-certs/v2026.3.19/ssl/cert.pem", try io_helper.readLink(pem, &link_buf));
}

test "the tree root is found from an install path, nested domains included" {
    try std.testing.expectEqualStrings("/g/packages", treeRootOf("/g/packages/openssl.org/v3.6.1", "openssl.org").?);
    try std.testing.expectEqualStrings("/p/pantry", treeRootOf("/p/pantry/curl.se/ca-certs/v2026.3.19", "curl.se/ca-certs").?);
}
