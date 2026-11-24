//! The CA bundle for installed OpenSSLs.
//!
//! A pkgx-layout OpenSSL looks for its certificates beside its own library,
//! `<prefix>/ssl/cert.pem` (props/x509_def.c.diff), so it works wherever the
//! tree is installed. The artifact ships no bundle: that is curl.se/ca-certs,
//! a package of its own. Without the link, everything built on that OpenSSL
//! (python.org's `ssl`, and so yt-dlp, pip and urllib) failed every HTTPS
//! request with CERTIFICATE_VERIFY_FAILED. Packages whose published runtime
//! closure bundles libcrypto (php.net, python.org, ...) carry the same
//! relocating OpenSSL in their own lib/, so it looks in `<that package>/ssl`;
//! php's stream HTTPS failed the same way. So every installed package that
//! carries a libcrypto and has no `ssl/cert.pem` gets a relative link to the
//! newest installed bundle, and one left dangling by a removed bundle is
//! repointed.

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

/// True when `pkg` (an installed `<domain>/v<version>` directory) carries a
/// libcrypto of its own: openssl.org itself, or any package whose published
/// runtime closure bundles OpenSSL (php.net, python.org, curl.se, ...). That
/// copy finds certificates relative to itself, at `<pkg>/ssl/cert.pem`.
pub fn carriesOpenSSL(pkg: []const u8) bool {
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    for ([_][]const u8{ "lib", "lib64" }) |lib| {
        const dir_path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ pkg, lib }) catch continue;
        var dir = io_helper.openDirAbsoluteForIteration(dir_path) catch continue;
        defer dir.close();
        var it = dir.iterate();
        while (it.next() catch null) |entry| {
            if (std.mem.startsWith(u8, entry.name, "libcrypto.") or std.mem.startsWith(u8, entry.name, "libcrypto-")) return true;
        }
    }
    return false;
}

/// Link `<pkg>/ssl/cert.pem` to `bundle` (a `curl.se/ca-certs` version
/// directory name) when `pkg` carries an OpenSSL and has no readable bundle.
/// `domain` sets how far the relative link climbs back to the tree root.
fn linkPackage(allocator: std.mem.Allocator, pkg: []const u8, domain: []const u8, bundle: []const u8) void {
    if (!carriesOpenSSL(pkg)) return;
    const ssl_dir = std.fmt.allocPrint(allocator, "{s}/ssl", .{pkg}) catch return;
    defer allocator.free(ssl_dir);
    const pem = std.fmt.allocPrint(allocator, "{s}/cert.pem", .{ssl_dir}) catch return;
    defer allocator.free(pem);
    // Present and readable (a bundle of its own, or a live link): leave it.
    if (io_helper.accessAbsolute(pem, .{})) |_| return else |_| {}
    var target: std.ArrayList(u8) = .empty;
    defer target.deinit(allocator);
    // ssl/ -> v<version>/ -> one directory per domain segment -> the root.
    const levels = std.mem.countScalar(u8, domain, '/') + 3;
    for (0..levels) |_| target.appendSlice(allocator, "../") catch return;
    target.print(allocator, "curl.se/ca-certs/{s}/ssl/cert.pem", .{bundle}) catch return;
    io_helper.makePath(ssl_dir) catch return;
    // Missing, or a link whose bundle is gone.
    io_helper.deleteFile(pem) catch {};
    io_helper.symLink(target.items, pem) catch {};
}

fn isVersionDir(name: []const u8) bool {
    return name.len >= 2 and name[0] == 'v' and std.ascii.isDigit(name[1]);
}

/// Visit every real `<domain>/v<version>` directory below `dir`; `domain`
/// is the path walked so far. Version aliases (`v3`, `v3.6`) are links and
/// are skipped, so each install is visited once.
fn walkPackages(allocator: std.mem.Allocator, dir: []const u8, domain: []const u8, depth: usize, bundle: []const u8) void {
    if (depth > 4) return;
    var handle = io_helper.openDirAbsoluteForIteration(dir) catch return;
    defer handle.close();
    var it = handle.iterate();
    while (it.next() catch null) |entry| {
        if (entry.kind != .directory or entry.name.len == 0 or entry.name[0] == '.') continue;
        const child = std.fmt.allocPrint(allocator, "{s}/{s}", .{ dir, entry.name }) catch continue;
        defer allocator.free(child);
        if (domain.len > 0 and isVersionDir(entry.name)) {
            linkPackage(allocator, child, domain, bundle);
            continue;
        }
        const child_domain = if (domain.len == 0)
            allocator.dupe(u8, entry.name) catch continue
        else
            std.fmt.allocPrint(allocator, "{s}/{s}", .{ domain, entry.name }) catch continue;
        defer allocator.free(child_domain);
        walkPackages(allocator, child, child_domain, depth + 1, bundle);
    }
}

/// Link every installed package under `root` (the directory domains are
/// installed in: `<global>/packages` or a project's `pantry`) that carries an
/// OpenSSL to the newest CA bundle there.
pub fn linkBundles(allocator: std.mem.Allocator, root: []const u8) void {
    const ca_dir = std.fmt.allocPrint(allocator, "{s}/curl.se/ca-certs", .{root}) catch return;
    defer allocator.free(ca_dir);
    var name_buf: [256]u8 = undefined;
    const bundle = newestBundle(allocator, ca_dir, &name_buf) orelse return;
    walkPackages(allocator, root, "", 0, bundle);
}

/// Link one just-installed package to the newest CA bundle under `root`.
pub fn linkInstalled(allocator: std.mem.Allocator, root: []const u8, install_path: []const u8, domain: []const u8) void {
    const ca_dir = std.fmt.allocPrint(allocator, "{s}/curl.se/ca-certs", .{root}) catch return;
    defer allocator.free(ca_dir);
    var name_buf: [256]u8 = undefined;
    const bundle = newestBundle(allocator, ca_dir, &name_buf) orelse return;
    linkPackage(allocator, install_path, domain, bundle);
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
    try touch(root, "openssl.org/v1.1.1w/lib/libcrypto.1.1.dylib");

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

fn touch(root: []const u8, relative: []const u8) !void {
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrint(&buf, "{s}/{s}", .{ root, relative });
    try io_helper.makePath(std.fs.path.dirname(path).?);
    io_helper.closeFile(try io_helper.createFileAbsolute(path, .{}));
}

test "a package that bundles OpenSSL gets the bundle beside its own libcrypto" {
    const testing = std.testing;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];

    try touch(root, "curl.se/ca-certs/v2026.3.19/ssl/cert.pem");
    // php.net's runtime closure carries libcrypto in its own lib/ (darwin)
    try touch(root, "php.net/v8.5.12/lib/libcrypto.3.dylib");
    // a nested domain with an ELF libcrypto in lib64
    try touch(root, "example.com/tool/v1.0.0/lib64/libcrypto.so.3");
    // no OpenSSL of its own: left alone
    try touch(root, "zlib.net/v1.4/lib/libz.1.dylib");
    // a version alias is a link to the real directory, visited once
    var link_buf: [std.fs.max_path_bytes]u8 = undefined;
    try io_helper.symLink("v8.5.12", try std.fmt.bufPrint(&link_buf, "{s}/php.net/v8", .{root}));

    linkBundles(testing.allocator, root);

    var buf: [std.fs.max_path_bytes]u8 = undefined;
    var read_buf: [std.fs.max_path_bytes]u8 = undefined;
    const php = try std.fmt.bufPrint(&buf, "{s}/php.net/v8.5.12/ssl/cert.pem", .{root});
    try io_helper.accessAbsolute(php, .{});
    try testing.expectEqualStrings("../../../curl.se/ca-certs/v2026.3.19/ssl/cert.pem", try io_helper.readLink(php, &read_buf));
    const nested = try std.fmt.bufPrint(&buf, "{s}/example.com/tool/v1.0.0/ssl/cert.pem", .{root});
    try io_helper.accessAbsolute(nested, .{});
    try testing.expectEqualStrings("../../../../curl.se/ca-certs/v2026.3.19/ssl/cert.pem", try io_helper.readLink(nested, &read_buf));
    const zlib = try std.fmt.bufPrint(&buf, "{s}/zlib.net/v1.4/ssl", .{root});
    try testing.expectError(error.FileNotFound, io_helper.accessAbsolute(zlib, .{}));
}

test "a package installed after the bundle is linked on its own" {
    const testing = std.testing;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];
    try touch(root, "curl.se/ca-certs/v2026.3.19/ssl/cert.pem");
    try touch(root, "python.org/v3.12.9/lib/libcrypto.so.3");
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const pkg = try std.fmt.bufPrint(&buf, "{s}/python.org/v3.12.9", .{root});
    linkInstalled(testing.allocator, root, pkg, "python.org");
    var pem_buf: [std.fs.max_path_bytes]u8 = undefined;
    try io_helper.accessAbsolute(try std.fmt.bufPrint(&pem_buf, "{s}/ssl/cert.pem", .{pkg}), .{});
}
