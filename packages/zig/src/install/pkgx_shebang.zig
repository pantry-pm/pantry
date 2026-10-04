//! pkgx-style shebangs, rewritten at install time.
//!
//! Registry artifacts mirrored from pkgx carry scripts whose interpreter is
//! resolved by pkgx at run time:
//!
//!     #!/usr/bin/env -S pkgx python@3.11
//!
//! aws.amazon.com/cli's `bin/aws` is one. pantry installs no `pkgx` on PATH,
//! so running it failed with "pkgx: No such file or directory" - and even
//! with pkgx present, pkgx would go and download its own python rather than
//! use the one pantry installed. The shebang is also the only place that says
//! which interpreter the artifact needs: aws's bundled venv holds
//! `lib/python3.11/site-packages` and `cpython-311` extension modules, so it
//! runs on 3.11 and nothing else, whatever range its catalog entry declares.
//!
//! So after a package is installed, every script in its `bin/` and `sbin/`
//! whose shebang goes through pkgx is pointed at the interpreter pantry has
//! installed in the same tree, installing a satisfying version first when the
//! tree has none.

const std = @import("std");
const builtin = @import("builtin");
const io_helper = @import("../io_helper.zig");
const semver = @import("../packages/semver.zig");
const generated = @import("../packages/generated.zig");
const style = @import("../cli/style.zig");

/// A parsed pkgx shebang. Slices point into the line it was parsed from.
pub const PkgxShebang = struct {
    /// The program pkgx would run: `python`, `deno`, or a domain such as
    /// `python.org` when the script names one.
    program: []const u8,
    /// The version part as written (`@3.11`, `^2`, or empty); `constraint()`
    /// gives it in the spelling pantry's resolver reads.
    raw_constraint: []const u8,
    /// Whatever follows the program on the line (`run -A`), trimmed.
    args: []const u8,
    /// `+pkg` entries pkgx would add to the environment, without the `+`.
    extra: [max_extra][]const u8 = undefined,
    extra_len: usize = 0,

    pub const max_extra = 8;

    /// The constraint pantry's resolver understands (`~3.11`, `^3`, `3.11.2`,
    /// `>=1.2`), or empty for any version.
    pub fn constraint(self: *const PkgxShebang, buf: []u8) []const u8 {
        return normalizeConstraint(self.raw_constraint, buf) orelse "";
    }

    pub fn extras(self: *const PkgxShebang) []const []const u8 {
        return self.extra[0..self.extra_len];
    }
};

/// Parse the first line of a script (with or without the leading `#!`, and
/// with or without its newline). Null when the line does not run through pkgx.
///
/// Accepted shapes, all seen in pkgx-built artifacts or pkgx's docs:
///   #!/usr/bin/env -S pkgx python@3.11
///   #!/usr/bin/env -S pkgx --quiet +openssl.org python@3.11 -u
///   #!/usr/bin/env pkgx deno^2 run -A
///   #!/usr/local/bin/pkgx node@20
pub fn parse(first_line: []const u8) ?PkgxShebang {
    var line = first_line;
    if (std.mem.indexOfScalar(u8, line, '\n')) |nl| line = line[0..nl];
    line = std.mem.trimEnd(u8, line, "\r");
    if (std.mem.startsWith(u8, line, "#!")) line = line[2..];
    line = std.mem.trim(u8, line, " \t");

    var tokens = std.mem.tokenizeAny(u8, line, " \t");
    const interp = tokens.next() orelse return null;

    // The token that should be pkgx, possibly still to be read from `tokens`.
    var pending: ?[]const u8 = null;
    if (std.mem.eql(u8, std.fs.path.basename(interp), "env")) {
        // env's own options: `-S`, `-i`, `-S<string>` fused, `-u NAME`...
        while (tokens.next()) |t| {
            if (t.len > 0 and t[0] == '-') {
                if (std.mem.startsWith(u8, t, "-S") and t.len > 2) {
                    pending = t[2..];
                    break;
                }
                if (std.mem.eql(u8, t, "-u")) _ = tokens.next();
                continue;
            }
            // `env NAME=value pkgx ...`
            if (std.mem.indexOfScalar(u8, t, '=') != null) continue;
            pending = t;
            break;
        }
    } else {
        pending = interp;
    }

    const pkgx_tok = pending orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(pkgx_tok), "pkgx")) return null;

    var result = PkgxShebang{ .program = "", .raw_constraint = "", .args = "" };
    while (tokens.next()) |t| {
        if (t[0] == '-') continue; // pkgx flags: --quiet, -q, -!, --
        if (t[0] == '+') {
            if (t.len > 1 and result.extra_len < PkgxShebang.max_extra) {
                result.extra[result.extra_len] = t[1..];
                result.extra_len += 1;
            }
            continue;
        }

        const op = std.mem.indexOfAny(u8, t, "@^~<>=") orelse t.len;
        if (op == 0) return null;
        result.program = t[0..op];
        result.raw_constraint = t[op..];
        var check: [64]u8 = undefined;
        if (normalizeConstraint(result.raw_constraint, &check) == null) return null;

        const rest_start = @intFromPtr(t.ptr) - @intFromPtr(line.ptr) + t.len;
        result.args = std.mem.trim(u8, line[rest_start..], " \t");
        return result;
    }
    return null;
}

/// pkgx's `@` spellings in the operators pantry's resolver reads: `@3` is the
/// 3.x line, `@3.11` the 3.11.x line, `@3.11.2` that release. Anything already
/// carrying an operator passes through.
fn normalizeConstraint(raw: []const u8, buf: []u8) ?[]const u8 {
    if (raw.len == 0 or std.mem.eql(u8, raw, "@*") or std.mem.eql(u8, raw, "*")) return "";
    if (raw[0] != '@') return raw;
    const v = raw[1..];
    if (v.len == 0) return "";
    var dots: usize = 0;
    for (v) |c| {
        if (c == '.') dots += 1;
    }
    return switch (dots) {
        0 => std.fmt.bufPrint(buf, "^{s}", .{v}) catch null,
        1 => std.fmt.bufPrint(buf, "~{s}", .{v}) catch null,
        else => v,
    };
}

/// The domain that provides `program`. A program written as a domain
/// (`python.org`) is that domain. Otherwise the catalog is searched for a
/// package listing the program, preferring one already installed in `root`
/// and then one whose short name is the program itself (`python` →
/// python.org rather than a package that happens to ship a `python` too).
pub fn programDomain(program: []const u8, root: ?[]const u8) ?[]const u8 {
    if (generated.getPackageByDomain(program)) |info| return info.domain;

    var first: ?[]const u8 = null;
    var named: ?[]const u8 = null;
    for (&generated.packages) |*pkg| {
        const provides = for (pkg.programs) |p| {
            if (std.mem.eql(u8, p, program)) break true;
        } else false;
        if (!provides) continue;

        if (root) |r| {
            var buf: [std.fs.max_path_bytes]u8 = undefined;
            const dir = std.fmt.bufPrint(&buf, "{s}/{s}", .{ r, pkg.domain }) catch continue;
            if (io_helper.accessAbsolute(dir, .{})) |_| return pkg.domain else |_| {}
        }
        if (first == null) first = pkg.domain;
        if (named == null and std.mem.eql(u8, pkg.name, program)) named = pkg.domain;
    }
    return named orelse first;
}

/// The newest `v<version>` entry under `<root>/<domain>` satisfying
/// `constraint` (any version when empty), written as its directory path into
/// `out`. Compat links (`v3`, `v3.11`) are candidates too; on a tie the full
/// version wins, so the path names the release that is actually there.
pub fn findInstalledVersion(root: []const u8, domain: []const u8, constraint: []const u8, out: []u8) ?[]const u8 {
    var dir_buf: [std.fs.max_path_bytes]u8 = undefined;
    const domain_dir = std.fmt.bufPrint(&dir_buf, "{s}/{s}", .{ root, domain }) catch return null;

    const parsed: ?semver.Constraint = if (constraint.len == 0)
        null
    else
        semver.parseConstraint(constraint) catch return null;

    var dir = io_helper.openDirAbsoluteForIteration(domain_dir) catch return null;
    defer dir.close();

    var best_buf: [256]u8 = undefined;
    var best: ?[]const u8 = null;
    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (entry.kind != .directory and entry.kind != .sym_link) continue;
        if (entry.name.len < 2 or entry.name[0] != 'v') continue;
        const version = entry.name[1..];
        _ = semver.parseVersion(version) catch continue;
        if (parsed) |c| {
            if (!semver.satisfiesConstraint(version, c)) continue;
        }
        if (best) |b| {
            switch (semver.compareVersions(version, b)) {
                .lt => continue,
                .eq => if (version.len <= b.len) continue,
                .gt => {},
            }
        }
        if (version.len > best_buf.len) continue;
        @memcpy(best_buf[0..version.len], version);
        best = best_buf[0..version.len];
    }

    const v = best orelse return null;
    return std.fmt.bufPrint(out, "{s}/v{s}", .{ domain_dir, v }) catch null;
}

/// The program's executable inside an installed package directory.
fn programPath(package_dir: []const u8, program: []const u8, out: []u8) ?[]const u8 {
    const name = std.fs.path.basename(program);
    for ([_][]const u8{ "bin", "sbin" }) |sub| {
        const p = std.fmt.bufPrint(out, "{s}/{s}/{s}", .{ package_dir, sub, name }) catch return null;
        if (io_helper.isExecutable(p)) return p;
    }
    return null;
}

/// `<root>` of an install at `<root>/<domain>/v<version>`, or null when the
/// path is not laid out that way.
pub fn installRoot(install_path: []const u8, domain: []const u8, version: []const u8) ?[]const u8 {
    var suffix_buf: [std.fs.max_path_bytes]u8 = undefined;
    const suffix = std.fmt.bufPrint(&suffix_buf, "/{s}/v{s}", .{ domain, version }) catch return null;
    const trimmed = std.mem.trimEnd(u8, install_path, "/");
    if (!std.mem.endsWith(u8, trimmed, suffix)) return null;
    const root = trimmed[0 .. trimmed.len - suffix.len];
    return if (root.len == 0) null else root;
}

/// Linux has read 256 bytes of a shebang line since 5.1 (127 before); a
/// longer interpreter path is silently cut short.
const max_shebang_line = 255;

/// The script's new first line(s), without the trailing newline, for an
/// interpreter at `interpreter`. When the path makes the line too long for
/// the kernel and the interpreter is Python, this is the `/bin/sh` trampoline
/// pip writes for the same reason: valid sh that execs python on the file,
/// and a no-op string literal to python.
pub fn renderShebang(allocator: std.mem.Allocator, interpreter: []const u8, args: []const u8) ![]u8 {
    const line = if (args.len == 0)
        try std.fmt.allocPrint(allocator, "#!{s}", .{interpreter})
    else
        try std.fmt.allocPrint(allocator, "#!/usr/bin/env -S {s} {s}", .{ interpreter, args });

    if (line.len <= max_shebang_line or !std.mem.startsWith(u8, std.fs.path.basename(interpreter), "python")) return line;
    allocator.free(line);

    if (args.len == 0)
        return std.fmt.allocPrint(allocator, "#!/bin/sh\n'''exec' \"{s}\" \"$0\" \"$@\"\n' '''", .{interpreter});
    return std.fmt.allocPrint(allocator, "#!/bin/sh\n'''exec' \"{s}\" {s} \"$0\" \"$@\"\n' '''", .{ interpreter, args });
}

/// Replace the first line of `content` with `new_first`. Caller owns the result.
pub fn replaceFirstLine(allocator: std.mem.Allocator, content: []const u8, new_first: []const u8) ![]u8 {
    const rest = if (std.mem.indexOfScalar(u8, content, '\n')) |nl| content[nl..] else "\n";
    return std.mem.concat(allocator, u8, &.{ new_first, rest });
}

/// Rewrite the script at `path` to run under `interpreter`. Written beside the
/// original and renamed over it, so a hard link the file shares with another
/// install tree (the global cache) keeps its own content.
fn rewriteScript(allocator: std.mem.Allocator, path: []const u8, content: []const u8, interpreter: []const u8, args: []const u8) !void {
    const first = try renderShebang(allocator, interpreter, args);
    defer allocator.free(first);
    const updated = try replaceFirstLine(allocator, content, first);
    defer allocator.free(updated);

    var tmp_buf: [std.fs.max_path_bytes]u8 = undefined;
    const tmp = try std.fmt.bufPrint(&tmp_buf, "{s}.pantry-shebang", .{path});
    const file = try io_helper.createFileAbsolute(tmp, .{ .truncate = true });
    io_helper.writeAllToFile(file, updated) catch |err| {
        io_helper.closeFile(file);
        io_helper.deleteFile(tmp) catch {};
        return err;
    };
    io_helper.closeFile(file);

    var zbuf: [std.fs.max_path_bytes:0]u8 = undefined;
    if (tmp.len < zbuf.len) {
        @memcpy(zbuf[0..tmp.len], tmp);
        zbuf[tmp.len] = 0;
        _ = std.c.chmod(&zbuf, 0o755);
    }
    io_helper.rename(tmp, path) catch |err| {
        io_helper.deleteFile(tmp) catch {};
        return err;
    };
}

/// Read up to the first `buf.len` bytes of the file at `path`.
fn readHead(path: []const u8, buf: []u8) ?[]const u8 {
    if (builtin.os.tag == .windows) return null;
    const fd = std.posix.openat(std.posix.AT.FDCWD, path, .{ .ACCMODE = .RDONLY }, 0) catch return null;
    defer _ = std.c.close(fd);
    const n = io_helper.platformRead(fd, buf) catch return null;
    return buf[0..n];
}

/// Point every pkgx shebang in the package at `install_path` (laid out as
/// `<root>/<domain>/v<version>`) at an interpreter in `<root>`. When `<root>`
/// has no version the shebang accepts, `installer.install` is asked for one -
/// `installer` is the package installer (anything with an `allocator` field
/// and pantry's `install(spec, options)`), and `options` are passed through so
/// the interpreter lands in the same tree.
///
/// Best-effort: a script that cannot be resolved is left as it was and
/// reported, and nothing here fails the install.
pub fn fixInstalledPackage(installer: anytype, install_path: []const u8, domain: []const u8, version: []const u8, options: anytype) void {
    if (builtin.os.tag == .windows) return;
    const allocator = installer.allocator;
    const root = installRoot(install_path, domain, version) orelse return;

    for ([_][]const u8{ "bin", "sbin" }) |sub| {
        var dir_buf: [std.fs.max_path_bytes]u8 = undefined;
        const dir_path = std.fmt.bufPrint(&dir_buf, "{s}/{s}", .{ install_path, sub }) catch continue;
        var dir = io_helper.openDirAbsoluteForIteration(dir_path) catch continue;
        defer dir.close();

        var it = dir.iterate();
        while (it.next() catch null) |entry| {
            // A link points at a file this loop or another package handles.
            if (entry.kind != .file) continue;

            var path_buf: [std.fs.max_path_bytes]u8 = undefined;
            const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ dir_path, entry.name }) catch continue;

            var head_buf: [1024]u8 = undefined;
            const head = readHead(path, &head_buf) orelse continue;
            if (!std.mem.startsWith(u8, head, "#!")) continue;
            const shebang = parse(head) orelse continue;

            var interp_buf: [std.fs.max_path_bytes]u8 = undefined;
            const interpreter = resolveInterpreter(installer, root, domain, &shebang, options, &interp_buf) orelse {
                style.print("  ! {s}/{s}: no installed interpreter for `pkgx {s}{s}`, left as-is\n", .{ domain, entry.name, shebang.program, shebang.raw_constraint });
                continue;
            };

            const content = io_helper.readFileAllocAbsolute(allocator, path, 64 * 1024 * 1024) catch continue;
            defer allocator.free(content);
            rewriteScript(allocator, path, content, interpreter, shebang.args) catch |err| {
                style.print("  ! {s}/{s}: could not rewrite its pkgx shebang: {}\n", .{ domain, entry.name, err });
            };
        }
    }
}

fn resolveInterpreter(installer: anytype, root: []const u8, owner: []const u8, shebang: *const PkgxShebang, options: anytype, out: []u8) ?[]const u8 {
    const program = shebang.program;
    var own_cbuf: [64]u8 = undefined;
    var wanted = shebang.constraint(&own_cbuf);
    var extra_cbuf: [64]u8 = undefined;

    // `pkgx +python.org~3.11 python`: the constraint rides on the extra.
    const interp_domain = blk: {
        const by_program = programDomain(program, root);
        for (shebang.extras()) |extra| {
            const op = std.mem.indexOfAny(u8, extra, "@^~<>=") orelse extra.len;
            const extra_domain = extra[0..op];
            const provides = if (by_program) |d| std.mem.eql(u8, d, extra_domain) else false;
            if (provides or std.mem.eql(u8, extra_domain, program)) {
                if (wanted.len == 0) wanted = normalizeConstraint(extra[op..], &extra_cbuf) orelse "";
                break :blk extra_domain;
            }
        }
        break :blk by_program orelse return null;
    };

    // The extras are part of the environment pkgx would have built. A shebang
    // cannot carry an environment, but having them installed puts their
    // programs on the project's PATH, which is what scripts lean on.
    for (shebang.extras()) |extra| {
        const op = std.mem.indexOfAny(u8, extra, "@^~<>=") orelse extra.len;
        const extra_domain = extra[0..op];
        if (std.mem.eql(u8, extra_domain, interp_domain) or std.mem.eql(u8, extra_domain, owner)) continue;
        var pkg_buf: [std.fs.max_path_bytes]u8 = undefined;
        if (findInstalledVersion(root, extra_domain, "", &pkg_buf) != null) continue;
        var cbuf: [64]u8 = undefined;
        const c = normalizeConstraint(extra[op..], &cbuf) orelse "";
        installQuietly(installer, extra_domain, c, options);
    }

    var pkg_buf: [std.fs.max_path_bytes]u8 = undefined;
    var pkg_dir = findInstalledVersion(root, interp_domain, wanted, &pkg_buf);
    if (pkg_dir == null and !std.mem.eql(u8, interp_domain, owner)) {
        installQuietly(installer, interp_domain, wanted, options);
        pkg_dir = findInstalledVersion(root, interp_domain, wanted, &pkg_buf);
    }
    if (pkg_dir == null and wanted.len > 0) {
        // Nothing satisfying could be installed. An interpreter of the wrong
        // version is still more use than `pkgx: No such file or directory`,
        // and says what it is.
        pkg_dir = findInstalledVersion(root, interp_domain, "", &pkg_buf);
        if (pkg_dir) |d| style.print("  ! {s}{s} is not available; pkgx scripts in {s} will use {s}\n", .{ interp_domain, wanted, owner, std.fs.path.basename(d) });
    }
    const dir = pkg_dir orelse return null;

    const exe_name = if (std.mem.indexOfScalar(u8, program, '.') != null) std.fs.path.basename(interp_domain) else program;
    return programPath(dir, exe_name, out);
}

fn installQuietly(installer: anytype, domain: []const u8, constraint: []const u8, options: anytype) void {
    const version = if (constraint.len == 0) "latest" else constraint;
    var result = installer.install(.{ .name = domain, .version = version }, options) catch |err| {
        style.print("  ! could not install {s}@{s} for a pkgx shebang: {}\n", .{ domain, version, err });
        return;
    };
    result.deinit(installer.allocator);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "parse: aws-cli's wrapper" {
    var cb: [64]u8 = undefined;
    const s = parse("#!/usr/bin/env -S pkgx python@3.11\n\nimport os\n").?;
    try testing.expectEqualStrings("python", s.program);
    try testing.expectEqualStrings("~3.11", s.constraint(&cb));
    try testing.expectEqualStrings("", s.args);
    try testing.expectEqual(@as(usize, 0), s.extra_len);
}

test "parse: flags, extras and trailing args" {
    var cb: [64]u8 = undefined;
    const s = parse("#!/usr/bin/env -S pkgx --quiet +openssl.org +curl.se^8 deno^2 run -A --unstable\n").?;
    try testing.expectEqualStrings("deno", s.program);
    try testing.expectEqualStrings("^2", s.constraint(&cb));
    try testing.expectEqualStrings("run -A --unstable", s.args);
    try testing.expectEqual(@as(usize, 2), s.extra_len);
    try testing.expectEqualStrings("openssl.org", s.extras()[0]);
    try testing.expectEqualStrings("curl.se^8", s.extras()[1]);
}

test "parse: env without -S, pkgx by path, fused -S, CRLF" {
    var cb: [64]u8 = undefined;
    const a = parse("#!/usr/bin/env pkgx node@20").?;
    try testing.expectEqualStrings("node", a.program);
    try testing.expectEqualStrings("^20", a.constraint(&cb));

    const b = parse("#!/usr/local/bin/pkgx ruby@3.3.4 -w\r\n").?;
    try testing.expectEqualStrings("ruby", b.program);
    try testing.expectEqualStrings("3.3.4", b.constraint(&cb));
    try testing.expectEqualStrings("-w", b.args);

    const c = parse("#!/usr/bin/env -Spkgx python").?;
    try testing.expectEqualStrings("python", c.program);
    try testing.expectEqualStrings("", c.constraint(&cb));
}

test "parse: shebangs that do not go through pkgx are left alone" {
    try testing.expect(parse("#!/usr/bin/env python3") == null);
    try testing.expect(parse("#!/bin/sh") == null);
    try testing.expect(parse("#!/opt/aws.amazon.com/cli/v2.34.15+brewing/venv/bin/python") == null);
    try testing.expect(parse("#!/usr/bin/env -S pkgx") == null);
    try testing.expect(parse("#!/usr/bin/env -S pkgxx python") == null);
    try testing.expect(parse("") == null);
}

test "programDomain finds python.org for `python`" {
    try testing.expectEqualStrings("python.org", programDomain("python", null).?);
    try testing.expectEqualStrings("python.org", programDomain("python.org", null).?);
    try testing.expect(programDomain("definitely-not-a-program-xyz", null) == null);
}

test "installRoot strips the domain and version" {
    try testing.expectEqualStrings("/p/pantry", installRoot("/p/pantry/aws.amazon.com/cli/v2.34.15", "aws.amazon.com/cli", "2.34.15").?);
    try testing.expectEqualStrings("/g/packages", installRoot("/g/packages/python.org/v3.11.15/", "python.org", "3.11.15").?);
    try testing.expect(installRoot("/p/pantry/other/v1.0.0", "python.org", "3.11.15") == null);
}

test "renderShebang: absolute path, args through env -S, python trampoline when too long" {
    const a = testing.allocator;

    const plain = try renderShebang(a, "/p/pantry/python.org/v3.11.15/bin/python", "");
    defer a.free(plain);
    try testing.expectEqualStrings("#!/p/pantry/python.org/v3.11.15/bin/python", plain);

    const with_args = try renderShebang(a, "/p/deno.land/v2.1.0/bin/deno", "run -A");
    defer a.free(with_args);
    try testing.expectEqualStrings("#!/usr/bin/env -S /p/deno.land/v2.1.0/bin/deno run -A", with_args);

    const long_dir = comptime blk: {
        var s: []const u8 = "/very";
        for (0..60) |_| s = s ++ "/long";
        break :blk s ++ "/python.org/v3.11.15/bin/python";
    };
    const long = try renderShebang(a, long_dir, "");
    defer a.free(long);
    try testing.expect(std.mem.startsWith(u8, long, "#!/bin/sh\n'''exec' \"" ++ long_dir ++ "\" \"$0\" \"$@\"\n"));
}

test "fixInstalledPackage rewrites aws's wrapper to the installed python" {
    const a = testing.allocator;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const base = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];

    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = try std.fmt.allocPrint(a, "{s}/pantry", .{base});
    defer a.free(root);

    // python 3.14 and 3.11 side by side, as an install of aws leaves them.
    for ([_][]const u8{ "3.14.8", "3.11.15" }) |v| {
        const bin = try std.fmt.bufPrint(&buf, "{s}/python.org/v{s}/bin", .{ root, v });
        try io_helper.makePath(bin);
        var exe_buf: [std.fs.max_path_bytes]u8 = undefined;
        const exe = try std.fmt.bufPrint(&exe_buf, "{s}/python", .{bin});
        const f = try io_helper.createFileAbsolute(exe, .{ .truncate = true });
        try io_helper.writeAllToFile(f, "#!/bin/sh\n");
        io_helper.closeFile(f);
        var z: [std.fs.max_path_bytes:0]u8 = undefined;
        @memcpy(z[0..exe.len], exe);
        z[exe.len] = 0;
        _ = std.c.chmod(&z, 0o755);
    }
    var link_buf: [std.fs.max_path_bytes]u8 = undefined;
    try io_helper.symLink("v3.14.8", try std.fmt.bufPrint(&link_buf, "{s}/python.org/v3", .{root}));

    const pkg = try std.fmt.allocPrint(a, "{s}/aws.amazon.com/cli/v2.34.15", .{root});
    defer a.free(pkg);
    const aws_bin = try std.fmt.bufPrint(&buf, "{s}/bin", .{pkg});
    try io_helper.makePath(aws_bin);
    const script = "#!/usr/bin/env -S pkgx python@3.11\n\nimport os\nprint('hi') # not a shebang\n";
    var aws_buf: [std.fs.max_path_bytes]u8 = undefined;
    const aws = try std.fmt.bufPrint(&aws_buf, "{s}/aws", .{aws_bin});
    {
        const f = try io_helper.createFileAbsolute(aws, .{ .truncate = true });
        try io_helper.writeAllToFile(f, script);
        io_helper.closeFile(f);
    }
    // A plain script beside it must not be touched.
    var other_buf: [std.fs.max_path_bytes]u8 = undefined;
    const other = try std.fmt.bufPrint(&other_buf, "{s}/aws_completer", .{aws_bin});
    {
        const f = try io_helper.createFileAbsolute(other, .{ .truncate = true });
        try io_helper.writeAllToFile(f, "#!/usr/bin/env python3\n");
        io_helper.closeFile(f);
    }

    var fake = FakeInstaller{ .allocator = a };
    fixInstalledPackage(&fake, pkg, "aws.amazon.com/cli", "2.34.15", {});
    try testing.expectEqual(@as(usize, 0), fake.calls);

    const got = try io_helper.readFileAllocAbsolute(a, aws, 1 << 20);
    defer a.free(got);
    const want = try std.fmt.allocPrint(a, "#!{s}/python.org/v3.11.15/bin/python\n\nimport os\nprint('hi') # not a shebang\n", .{root});
    defer a.free(want);
    try testing.expectEqualStrings(want, got);
    try testing.expect(io_helper.isExecutable(aws));

    const untouched = try io_helper.readFileAllocAbsolute(a, other, 1 << 20);
    defer a.free(untouched);
    try testing.expectEqualStrings("#!/usr/bin/env python3\n", untouched);

    // Idempotent: a second pass finds nothing to do.
    fixInstalledPackage(&fake, pkg, "aws.amazon.com/cli", "2.34.15", {});
    const again = try io_helper.readFileAllocAbsolute(a, aws, 1 << 20);
    defer a.free(again);
    try testing.expectEqualStrings(want, again);
}

test "fixInstalledPackage installs the interpreter the shebang names when the tree has none" {
    const a = testing.allocator;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const base = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];

    const root = try std.fmt.allocPrint(a, "{s}/pantry", .{base});
    defer a.free(root);
    const pkg = try std.fmt.allocPrint(a, "{s}/aws.amazon.com/sam/v1.150.0", .{root});
    defer a.free(pkg);

    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const bin = try std.fmt.bufPrint(&buf, "{s}/bin", .{pkg});
    try io_helper.makePath(bin);
    var sam_buf: [std.fs.max_path_bytes]u8 = undefined;
    const sam = try std.fmt.bufPrint(&sam_buf, "{s}/sam", .{bin});
    {
        const f = try io_helper.createFileAbsolute(sam, .{ .truncate = true });
        try io_helper.writeAllToFile(f, "#!/usr/bin/env -S pkgx python@3.13\nimport sys\n");
        io_helper.closeFile(f);
    }

    var fake = FakeInstaller{ .allocator = a, .root = root, .provide = "3.13.16" };
    fixInstalledPackage(&fake, pkg, "aws.amazon.com/sam", "1.150.0", {});
    try testing.expectEqual(@as(usize, 1), fake.calls);
    try testing.expectEqualStrings("python.org", fake.last_name);
    try testing.expectEqualStrings("~3.13", fake.last_version);

    const got = try io_helper.readFileAllocAbsolute(a, sam, 1 << 20);
    defer a.free(got);
    const want = try std.fmt.allocPrint(a, "#!{s}/python.org/v3.13.16/bin/python\nimport sys\n", .{root});
    defer a.free(want);
    try testing.expectEqualStrings(want, got);
}

/// Stands in for the installer: records what it was asked for and, when it
/// has a version to provide, lays down `<root>/<domain>/v<version>/bin/python`.
const FakeInstaller = struct {
    allocator: std.mem.Allocator,
    root: []const u8 = "",
    provide: []const u8 = "",
    calls: usize = 0,
    last_name_buf: [64]u8 = undefined,
    last_name: []const u8 = "",
    last_version_buf: [64]u8 = undefined,
    last_version: []const u8 = "",

    const Spec = struct { name: []const u8, version: []const u8 };
    const Result = struct {
        fn deinit(_: *Result, _: std.mem.Allocator) void {}
    };

    fn install(self: *FakeInstaller, spec: Spec, _: void) !Result {
        self.calls += 1;
        @memcpy(self.last_name_buf[0..spec.name.len], spec.name);
        self.last_name = self.last_name_buf[0..spec.name.len];
        @memcpy(self.last_version_buf[0..spec.version.len], spec.version);
        self.last_version = self.last_version_buf[0..spec.version.len];
        if (self.provide.len == 0) return error.PackageNotFound;

        var buf: [std.fs.max_path_bytes]u8 = undefined;
        const bin = try std.fmt.bufPrint(&buf, "{s}/{s}/v{s}/bin", .{ self.root, spec.name, self.provide });
        try io_helper.makePath(bin);
        var exe_buf: [std.fs.max_path_bytes]u8 = undefined;
        const exe = try std.fmt.bufPrint(&exe_buf, "{s}/python", .{bin});
        const f = try io_helper.createFileAbsolute(exe, .{ .truncate = true });
        io_helper.closeFile(f);
        var z: [std.fs.max_path_bytes:0]u8 = undefined;
        @memcpy(z[0..exe.len], exe);
        z[exe.len] = 0;
        _ = std.c.chmod(&z, 0o755);
        return .{};
    }
};
