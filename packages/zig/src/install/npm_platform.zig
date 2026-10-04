//! Does an npm package version run on this machine?
//!
//! npm packages that ship native binaries publish one package per platform
//! (`@esbuild/darwin-arm64`, `@rollup/rollup-linux-x64-gnu`,
//! `@img/sharp-darwin-arm64`, `@sqld/darwin-arm64`, ...) and list every one of
//! them in the parent's `optionalDependencies`. Each platform package declares
//! where it runs with `os`, `cpu` and (on Linux) `libc`; the package manager
//! installs the ones that match and skips the rest. This is that check, with
//! npm's semantics (npm-install-checks): a list allows the values it names, a
//! `!value` entry blocks one, and a list of only blocks allows everything
//! else.

const std = @import("std");
const builtin = @import("builtin");
const io_helper = @import("../io_helper.zig");

pub const Host = struct {
    os: []const u8,
    cpu: []const u8,
    /// `glibc` or `musl` on Linux, null elsewhere.
    libc: ?[]const u8,

    pub fn current() Host {
        return .{ .os = hostOs(), .cpu = hostCpu(), .libc = hostLibc() };
    }
};

fn hostOs() []const u8 {
    return switch (builtin.os.tag) {
        .macos => "darwin",
        .linux => "linux",
        .windows => "win32",
        .freebsd => "freebsd",
        .openbsd => "openbsd",
        .netbsd => "netbsd",
        else => @tagName(builtin.os.tag),
    };
}

fn hostCpu() []const u8 {
    return switch (builtin.cpu.arch) {
        .aarch64 => "arm64",
        .x86_64 => "x64",
        .x86 => "ia32",
        .arm => "arm",
        .riscv64 => "riscv64",
        .powerpc64le => "ppc64",
        .s390x => "s390x",
        .loongarch64 => "loong64",
        else => @tagName(builtin.cpu.arch),
    };
}

fn hostLibc() ?[]const u8 {
    if (builtin.os.tag != .linux) return null;
    // musl's dynamic loader is /lib/ld-musl-<arch>.so.1; glibc has none.
    var dir = io_helper.openDirAbsoluteForIteration("/lib") catch return "glibc";
    defer dir.close();
    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (std.mem.startsWith(u8, entry.name, "ld-musl-")) return "musl";
    }
    return "glibc";
}

/// npm's list check: `["darwin", "linux"]` allows those, `["!win32"]` allows
/// everything but win32, and an empty or absent list allows everything.
pub fn listAllows(list: std.json.Value, value: ?[]const u8) bool {
    const items: []const std.json.Value = switch (list) {
        .array => |a| a.items,
        .string => &[_]std.json.Value{list},
        else => return true,
    };
    if (items.len == 0) return true;

    var has_allow = false;
    var allowed = false;
    for (items) |item| {
        if (item != .string) continue;
        const s = item.string;
        if (s.len > 0 and s[0] == '!') {
            if (value) |v| {
                if (std.mem.eql(u8, s[1..], v)) return false;
            }
            continue;
        }
        has_allow = true;
        if (value) |v| {
            if (std.mem.eql(u8, s, v)) allowed = true;
        }
    }
    return !has_allow or allowed;
}

/// Whether a package version (its registry or package.json object) may be
/// installed on `host`, judged by its `os`, `cpu` and `libc` fields.
pub fn allowsHost(version_data: std.json.Value, host: Host) bool {
    if (version_data != .object) return true;
    const obj = version_data.object;
    if (obj.get("os")) |os| if (!listAllows(os, host.os)) return false;
    if (obj.get("cpu")) |cpu| if (!listAllows(cpu, host.cpu)) return false;
    // libc only means something on Linux; elsewhere a package that asks for
    // one is a Linux build.
    if (obj.get("libc")) |libc| if (!listAllows(libc, host.libc)) return false;
    return true;
}

pub fn allowsCurrentHost(version_data: std.json.Value) bool {
    return allowsHost(version_data, Host.current());
}

test "platform packages: only the host's is allowed" {
    const a = std.testing.allocator;
    const darwin_arm64 = Host{ .os = "darwin", .cpu = "arm64", .libc = null };
    const linux_x64_gnu = Host{ .os = "linux", .cpu = "x64", .libc = "glibc" };
    const linux_x64_musl = Host{ .os = "linux", .cpu = "x64", .libc = "musl" };

    const cases = [_]struct { json: []const u8, darwin_arm64: bool, linux_gnu: bool, linux_musl: bool }{
        // @esbuild/darwin-arm64, @sqld/darwin-arm64
        .{ .json = "{\"os\":[\"darwin\"],\"cpu\":[\"arm64\"]}", .darwin_arm64 = true, .linux_gnu = false, .linux_musl = false },
        // @esbuild/linux-x64
        .{ .json = "{\"os\":[\"linux\"],\"cpu\":[\"x64\"]}", .darwin_arm64 = false, .linux_gnu = true, .linux_musl = true },
        // @rollup/rollup-linux-x64-gnu / -musl
        .{ .json = "{\"os\":[\"linux\"],\"cpu\":[\"x64\"],\"libc\":[\"glibc\"]}", .darwin_arm64 = false, .linux_gnu = true, .linux_musl = false },
        .{ .json = "{\"os\":[\"linux\"],\"cpu\":[\"x64\"],\"libc\":[\"musl\"]}", .darwin_arm64 = false, .linux_gnu = false, .linux_musl = true },
        // A block list.
        .{ .json = "{\"os\":[\"!win32\"]}", .darwin_arm64 = true, .linux_gnu = true, .linux_musl = true },
        // No platform fields: the parent package itself.
        .{ .json = "{\"name\":\"esbuild\"}", .darwin_arm64 = true, .linux_gnu = true, .linux_musl = true },
        // A bare string, which some packages publish.
        .{ .json = "{\"os\":\"darwin\"}", .darwin_arm64 = true, .linux_gnu = false, .linux_musl = false },
    };
    for (cases) |c| {
        const parsed = try std.json.parseFromSlice(std.json.Value, a, c.json, .{});
        defer parsed.deinit();
        try std.testing.expectEqual(c.darwin_arm64, allowsHost(parsed.value, darwin_arm64));
        try std.testing.expectEqual(c.linux_gnu, allowsHost(parsed.value, linux_x64_gnu));
        try std.testing.expectEqual(c.linux_musl, allowsHost(parsed.value, linux_x64_musl));
    }
}

test "the current host is described in npm's vocabulary" {
    const h = Host.current();
    if (builtin.os.tag == .macos) try std.testing.expectEqualStrings("darwin", h.os);
    if (builtin.cpu.arch == .aarch64) try std.testing.expectEqualStrings("arm64", h.cpu);
    if (builtin.cpu.arch == .x86_64) try std.testing.expectEqualStrings("x64", h.cpu);
}
