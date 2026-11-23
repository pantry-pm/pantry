//! `pantry publish --zig [path]`: publish a build.zig.zon package to a Pantry
//! registry's Zig endpoint (`POST <registry>/zig/publish`).
//!
//! This is the GitHub action's `publish: zig` path (packages/action/src/index.ts,
//! publishZigPackage), moved into the CLI so a package can be published from any
//! machine, and so an organisation whose Actions are unavailable can still ship:
//!
//! - name and version come from build.zig.zon; `.name` is an enum literal
//!   (`.zig_cli`), and the registry's canonical name uses hyphens (`zig-cli`),
//!   so the name is normalised and the manifest sent with it says `.@"zig-cli"`
//! - the tarball holds the `.paths` entries at its root (or build.zig,
//!   build.zig.zon and src when `.paths` is absent), with the same path filter:
//!   nothing containing `..`, nothing absolute
//! - the request is multipart: `tarball` (`<name>-<version>.tar.gz`) and
//!   `manifest` (the build.zig.zon text), with a bearer token
//! - 409, or a body saying "already exists", is a skip, not a failure
//!
//! Two differences, both about the machine rather than the package: the archive
//! is written natively (sorted, no owner names, no timestamps), so macOS never
//! adds AppleDouble `._*` or `.DS_Store` members that a Linux runner's tar would
//! never have seen; and after publishing, the served tarball is read back, its
//! sha256 checked against the registry's, and its package hash recomputed with
//! `zig fetch` when zig is installed, so a build.zig.zon entry can pin it.

const std = @import("std");
const io_helper = @import("../../io_helper.zig");
const style = @import("../style.zig");
const common = @import("common.zig");
const token_commands = @import("token.zig");

const CommandResult = common.CommandResult;

pub const Options = struct {
    registry: []const u8 = "https://registry.pantry.dev",
    token: ?[]const u8 = null,
    dry_run: bool = false,
    /// Read the published tarball back and recompute its hash.
    verify: bool = true,
};

pub const Package = struct {
    /// `.name` as written: `zig_cli`.
    raw_name: []const u8,
    /// The registry's canonical name: `zig-cli`.
    name: []const u8,
    version: []const u8,
    /// `.paths`, filtered; empty means the default set.
    paths: []const []const u8,
    /// The build.zig.zon text sent as the `manifest` field.
    manifest: []const u8,

    pub fn deinit(self: Package, allocator: std.mem.Allocator) void {
        allocator.free(self.raw_name);
        allocator.free(self.name);
        allocator.free(self.version);
        for (self.paths) |p| allocator.free(p);
        allocator.free(self.paths);
        allocator.free(self.manifest);
    }
};

pub const default_paths = [_][]const u8{ "build.zig", "build.zig.zon", "src" };

fn isIdentChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_';
}

fn skipSpace(text: []const u8, start: usize) usize {
    var i = start;
    while (i < text.len and std.ascii.isWhitespace(text[i])) : (i += 1) {}
    return i;
}

/// The first `.<field> = ` in `text`: index just past the `=` and spaces, and
/// where the `.field` began. `\.field\s*=\s*` in the action's regexes.
fn findField(text: []const u8, field: []const u8) ?struct { start: usize, value: usize } {
    var from: usize = 0;
    while (std.mem.indexOfPos(u8, text, from, field)) |at| {
        from = at + 1;
        const after = at + field.len;
        const eq = skipSpace(text, after);
        if (eq >= text.len or text[eq] != '=') continue;
        return .{ .start = at, .value = skipSpace(text, eq + 1) };
    }
    return null;
}

const NameValue = struct { name: []const u8, end: usize };

/// `.@"name"`, `.name` or `"name"`, starting at `i`.
fn parseNameValue(text: []const u8, i: usize) ?NameValue {
    if (std.mem.startsWith(u8, text[i..], ".@\"")) {
        const close = std.mem.indexOfScalarPos(u8, text, i + 3, '"') orelse return null;
        if (close == i + 3) return null;
        return .{ .name = text[i + 3 .. close], .end = close + 1 };
    }
    if (i < text.len and text[i] == '.') {
        var end = i + 1;
        while (end < text.len and isIdentChar(text[end])) : (end += 1) {}
        if (end == i + 1) return null;
        return .{ .name = text[i + 1 .. end], .end = end };
    }
    if (i < text.len and text[i] == '"') {
        const close = std.mem.indexOfScalarPos(u8, text, i + 1, '"') orelse return null;
        if (close == i + 1) return null;
        return .{ .name = text[i + 1 .. close], .end = close + 1 };
    }
    return null;
}

fn acceptablePath(p: []const u8) bool {
    if (p.len == 0) return false;
    if (std.mem.indexOf(u8, p, "..") != null) return false;
    if (p[0] == '/' or p[0] == '\\') return false;
    if (p.len >= 2 and std.ascii.isAlphabetic(p[0]) and p[1] == ':') return false;
    return true;
}

/// Read name, version and paths out of a build.zig.zon.
pub fn parseManifest(allocator: std.mem.Allocator, zon: []const u8) !Package {
    const name_field = findField(zon, ".name") orelse return error.ZonNameMissing;
    const name_value = parseNameValue(zon, name_field.value) orelse return error.ZonNameMissing;

    const version_field = findField(zon, ".version") orelse return error.ZonVersionMissing;
    if (version_field.value >= zon.len or zon[version_field.value] != '"') return error.ZonVersionMissing;
    const version_end = std.mem.indexOfScalarPos(u8, zon, version_field.value + 1, '"') orelse return error.ZonVersionMissing;
    if (version_end == version_field.value + 1) return error.ZonVersionMissing;
    const version = zon[version_field.value + 1 .. version_end];

    const raw_name = try allocator.dupe(u8, name_value.name);
    errdefer allocator.free(raw_name);
    const name = try allocator.dupe(u8, raw_name);
    errdefer allocator.free(name);
    std.mem.replaceScalar(u8, name, '_', '-');
    const owned_version = try allocator.dupe(u8, version);
    errdefer allocator.free(owned_version);

    var paths: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (paths.items) |p| allocator.free(p);
        paths.deinit(allocator);
    }
    if (findField(zon, ".paths")) |paths_field| {
        var open = paths_field.value;
        if (open < zon.len and zon[open] == '.') open += 1;
        if (open < zon.len and zon[open] == '{') {
            if (std.mem.indexOfScalarPos(u8, zon, open + 1, '}')) |close| {
                // Line comments are not paths.
                var lines = std.mem.splitScalar(u8, zon[open + 1 .. close], '\n');
                while (lines.next()) |raw_line| {
                    const line = if (std.mem.indexOf(u8, raw_line, "//")) |c| raw_line[0..c] else raw_line;
                    var items = std.mem.splitScalar(u8, line, ',');
                    while (items.next()) |item| {
                        var p = std.mem.trim(u8, item, " \t\r\n");
                        if (std.mem.startsWith(u8, p, "\"")) p = p[1..];
                        if (std.mem.endsWith(u8, p, "\"")) p = p[0 .. p.len - 1];
                        p = std.mem.trim(u8, p, " \t\r\n");
                        if (!acceptablePath(p)) continue;
                        try paths.append(allocator, try allocator.dupe(u8, p));
                    }
                }
            }
        }
    }

    // The registry reads `.name` from the manifest: send the canonical one.
    const manifest = if (std.mem.eql(u8, name, raw_name))
        try allocator.dupe(u8, zon)
    else
        try std.fmt.allocPrint(allocator, "{s}.name = .@\"{s}\"{s}", .{ zon[0..name_field.start], name, zon[name_value.end..] });
    errdefer allocator.free(manifest);

    return .{
        .raw_name = raw_name,
        .name = name,
        .version = owned_version,
        .paths = try paths.toOwnedSlice(allocator),
        .manifest = manifest,
    };
}

// ---------------------------------------------------------------------------
// Tarball
// ---------------------------------------------------------------------------

pub const Member = struct {
    path: []const u8,
    size: u64,
    directory: bool,
};

fn excludedName(name: []const u8) bool {
    return std.mem.startsWith(u8, name, "._") or std.mem.eql(u8, name, ".DS_Store");
}

const Packer = struct {
    allocator: std.mem.Allocator,
    tar: *std.tar.Writer,
    buffer: []u8,
    members: *std.ArrayList(Member),

    fn record(self: *Packer, path: []const u8, size: u64, directory: bool) !void {
        try self.members.append(self.allocator, .{ .path = try self.allocator.dupe(u8, path), .size = size, .directory = directory });
    }

    fn add(self: *Packer, root: []const u8, member: []const u8) anyerror!void {
        const source = try std.fs.path.join(self.allocator, &.{ root, member });
        defer self.allocator.free(source);
        const stat = io_helper.cwd().statFile(io_helper.io, source, .{ .follow_symlinks = false }) catch return error.PackagePathNotFound;
        switch (stat.kind) {
            .directory => return self.addDirectory(root, member),
            .sym_link => {
                const target = try io_helper.readLinkAlloc(self.allocator, source);
                defer self.allocator.free(target);
                if (target.len > 100) return error.SymlinkTargetTooLong;
                try self.tar.writeLink(member, target, .{});
                try self.record(member, 0, false);
                return;
            },
            .file => {},
            else => return error.UnsupportedPackageEntry,
        }
        const file = try io_helper.openFileAbsolute(source, .{});
        defer file.close(io_helper.io);
        const mode: u32 = if (comptime io_helper.File.Permissions.has_executable_bit)
            (if (stat.permissions.toMode() & 0o111 != 0) 0o755 else 0o644)
        else
            0o644;
        var reader = file.reader(io_helper.io, self.buffer);
        try self.tar.writeFileStream(member, stat.size, &reader.interface, .{ .mode = mode });
        try self.record(member, stat.size, false);
    }

    fn addDirectory(self: *Packer, root: []const u8, member: []const u8) anyerror!void {
        try self.tar.writeDir(member, .{ .mode = 0o755 });
        try self.record(member, 0, true);
        const path = try std.fs.path.join(self.allocator, &.{ root, member });
        defer self.allocator.free(path);
        var dir = try io_helper.openDirForIteration(path);
        defer dir.close();
        var names: std.ArrayList([]const u8) = .empty;
        defer {
            for (names.items) |n| self.allocator.free(n);
            names.deinit(self.allocator);
        }
        var it = dir.iterate();
        while (try it.next()) |entry| {
            if (excludedName(entry.name)) continue;
            try names.append(self.allocator, try self.allocator.dupe(u8, entry.name));
        }
        std.mem.sort([]const u8, names.items, {}, struct {
            fn lessThan(_: void, a: []const u8, b: []const u8) bool {
                return std.mem.lessThan(u8, a, b);
            }
        }.lessThan);
        for (names.items) |name| {
            const child = try std.fmt.allocPrint(self.allocator, "{s}/{s}", .{ member, name });
            defer self.allocator.free(child);
            try self.add(root, child);
        }
    }
};

pub const Tarball = struct {
    bytes: []u8,
    members: []Member,

    pub fn deinit(self: Tarball, allocator: std.mem.Allocator) void {
        allocator.free(self.bytes);
        for (self.members) |m| allocator.free(m.path);
        allocator.free(self.members);
    }
};

/// Pack `paths` (relative to `root`) into a gzipped tarball held in memory.
pub fn pack(allocator: std.mem.Allocator, root: []const u8, paths: []const []const u8) !Tarball {
    var members: std.ArrayList(Member) = .empty;
    errdefer {
        for (members.items) |m| allocator.free(m.path);
        members.deinit(allocator);
    }
    // The compressor writes through its sink's buffer, which must not start empty.
    var output = try std.Io.Writer.Allocating.initCapacity(allocator, 64 * 1024);
    defer output.deinit();
    const window = try allocator.alloc(u8, std.compress.flate.max_window_len);
    defer allocator.free(window);
    const compressor = try allocator.create(std.compress.flate.Compress);
    defer allocator.destroy(compressor);
    compressor.* = try .init(&output.writer, window, .gzip, std.compress.flate.Compress.Options.level_6);
    var tar: std.tar.Writer = .{ .underlying_writer = &compressor.writer };
    const buffer = try allocator.alloc(u8, 32 * 1024);
    defer allocator.free(buffer);
    var packer: Packer = .{ .allocator = allocator, .tar = &tar, .buffer = buffer, .members = &members };
    for (paths) |p| {
        const member = std.mem.trimEnd(u8, p, "/");
        if (member.len == 0 or excludedName(std.fs.path.basename(member))) continue;
        packer.add(root, member) catch |err| switch (err) {
            error.PackagePathNotFound => {
                style.printError("build.zig.zon lists \"{s}\" in .paths, but {s} has no such file or directory\n", .{ member, root });
                return err;
            },
            else => return err,
        };
    }
    try tar.finishPedantically();
    try compressor.finish();
    return .{ .bytes = try output.toOwnedSlice(), .members = try members.toOwnedSlice(allocator) };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

pub const boundary = "----PantryZigPublish7MA4YWxkTrZu0gW";

/// The multipart body the action's `curl -F tarball=@… -F manifest=<…` sent.
pub fn multipartBody(allocator: std.mem.Allocator, tarball_name: []const u8, tarball: []const u8, manifest: []const u8) ![]u8 {
    return std.fmt.allocPrint(allocator, "--{s}\r\nContent-Disposition: form-data; name=\"tarball\"; filename=\"{s}\"\r\nContent-Type: application/gzip\r\n\r\n{s}\r\n--{s}\r\nContent-Disposition: form-data; name=\"manifest\"\r\n\r\n{s}\r\n--{s}--\r\n", .{ boundary, tarball_name, tarball, boundary, manifest, boundary });
}

pub const Outcome = union(enum) {
    published: struct { hash: ?[]const u8, tarball_url: ?[]const u8, artifact_sha256: ?[]const u8 },
    already_exists,
    rejected: struct { status: u16, message: []const u8 },
};

/// Read the registry's answer the way the action does.
pub fn interpret(allocator: std.mem.Allocator, status: u16, body: []const u8) !Outcome {
    if (status == 409 or std.mem.indexOf(u8, body, "already exists") != null) return .already_exists;
    if (status >= 400 or status == 0) return .{ .rejected = .{ .status = status, .message = try allocator.dupe(u8, body) } };
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, body, .{}) catch
        return .{ .rejected = .{ .status = status, .message = try std.fmt.allocPrint(allocator, "unreadable response: {s}", .{body}) } };
    defer parsed.deinit();
    if (parsed.value != .object) return .{ .rejected = .{ .status = status, .message = try allocator.dupe(u8, body) } };
    const object = parsed.value.object;
    const success = object.get("success");
    if (success == null or success.? != .bool or !success.?.bool) {
        const message = if (object.get("error")) |e| (if (e == .string) e.string else "Publish failed") else "Publish failed";
        return .{ .rejected = .{ .status = status, .message = try allocator.dupe(u8, message) } };
    }
    const str = struct {
        fn get(a: std.mem.Allocator, o: std.json.ObjectMap, key: []const u8) !?[]const u8 {
            const v = o.get(key) orelse return null;
            return if (v == .string) try a.dupe(u8, v.string) else null;
        }
    };
    return .{ .published = .{
        .hash = try str.get(allocator, object, "hash"),
        .tarball_url = try str.get(allocator, object, "tarballUrl"),
        .artifact_sha256 = try str.get(allocator, object, "artifactSha256"),
    } };
}

pub fn freeOutcome(allocator: std.mem.Allocator, outcome: Outcome) void {
    switch (outcome) {
        .published => |p| {
            if (p.hash) |h| allocator.free(h);
            if (p.tarball_url) |u| allocator.free(u);
            if (p.artifact_sha256) |s| allocator.free(s);
        },
        .rejected => |r| allocator.free(r.message),
        .already_exists => {},
    }
}

fn post(allocator: std.mem.Allocator, url: []const u8, token: []const u8, body: []const u8) !io_helper.HttpResponse {
    const auth = try std.fmt.allocPrint(allocator, "Bearer {s}", .{token});
    defer allocator.free(auth);
    const content_type = "multipart/form-data; boundary=" ++ boundary;
    var client: std.http.Client = .{ .allocator = allocator, .io = io_helper.io };
    defer client.deinit();
    var response = std.Io.Writer.Allocating.init(allocator);
    defer response.deinit();
    var redirect_buf: [8192]u8 = undefined;
    const result = try client.fetch(.{
        .location = .{ .url = url },
        .method = .POST,
        .payload = body,
        .response_writer = &response.writer,
        .redirect_buffer = &redirect_buf,
        .redirect_behavior = .unhandled,
        .headers = .{
            .content_type = .{ .override = content_type },
            .authorization = .{ .override = auth },
        },
    });
    return .{ .status = @backingInt(result.status), .body = try response.toOwnedSlice() };
}

// ---------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------

fn sha256Hex(bytes: []const u8) [64]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

/// What the registry serves for `name@version`, checked: the metadata's hash and
/// sha256, the tarball's bytes against that sha256, and (with zig) the package
/// hash `zig fetch` computes. Returns the hash a build.zig.zon entry pins.
fn verifyServed(allocator: std.mem.Allocator, registry: []const u8, name: []const u8, version: []const u8, uploaded_sha256: ?[]const u8) !?[]u8 {
    const metadata_url = try std.fmt.allocPrint(allocator, "{s}/zig/packages/{s}/{s}", .{ registry, name, version });
    defer allocator.free(metadata_url);
    const tarball_url = try std.fmt.allocPrint(allocator, "{s}/tarball", .{metadata_url});
    defer allocator.free(tarball_url);

    const metadata = try io_helper.httpGetResponseTimeout(allocator, metadata_url, &.{}, 30_000);
    defer metadata.deinit(allocator);
    if (!metadata.ok()) {
        style.printError("{s} answered HTTP {d}\n", .{ metadata_url, metadata.status });
        return error.PublishedPackageNotServed;
    }
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, metadata.body, .{});
    defer parsed.deinit();
    const registry_hash = if (parsed.value == .object) (if (parsed.value.object.get("hash")) |h| (if (h == .string) h.string else null) else null) else null;
    const registry_sha = if (parsed.value == .object) (if (parsed.value.object.get("artifactSha256")) |h| (if (h == .string) h.string else null) else null) else null;

    const tarball = try io_helper.httpGetResponseTimeout(allocator, tarball_url, &.{}, 120_000);
    defer tarball.deinit(allocator);
    if (!tarball.ok()) {
        style.printError("{s} answered HTTP {d}\n", .{ tarball_url, tarball.status });
        return error.PublishedPackageNotServed;
    }
    const served_sha = sha256Hex(tarball.body);
    style.print("  Served: {s} (HTTP {d}, {d} bytes, sha256 {s})\n", .{ tarball_url, tarball.status, tarball.body.len, &served_sha });
    if (registry_sha) |expected| if (!std.mem.eql(u8, expected, &served_sha)) {
        style.printError("the served tarball's sha256 is not the one the registry recorded ({s})\n", .{expected});
        return error.PublishedTarballMismatch;
    };
    if (uploaded_sha256) |expected| if (!std.mem.eql(u8, expected, &served_sha)) {
        style.printError("the served tarball is not the one this run uploaded (sha256 {s})\n", .{expected});
        return error.PublishedTarballMismatch;
    };

    const zig = io_helper.findExecutable(allocator, "zig") catch null;
    if (zig) |zig_path| {
        defer allocator.free(zig_path);
        const result = io_helper.childRun(allocator, &.{ zig_path, "fetch", tarball_url }) catch null;
        if (result) |r| {
            defer allocator.free(r.stdout);
            defer allocator.free(r.stderr);
            const computed = std.mem.trim(u8, r.stdout, " \t\r\n");
            if (r.term == .exited and r.term.exited == 0 and computed.len > 0) {
                if (registry_hash) |expected| if (!std.mem.eql(u8, expected, computed)) {
                    style.printError("zig fetch computes {s}, but the registry recorded {s}\n", .{ computed, expected });
                    return error.PublishedHashMismatch;
                };
                style.print("  zig fetch: {s} (matches the registry)\n", .{computed});
                return try allocator.dupe(u8, computed);
            }
            style.printWarn("zig fetch could not read {s}: {s}\n", .{ tarball_url, r.stderr });
        }
    } else {
        style.printWarn("zig is not on PATH: the package hash was not recomputed locally\n", .{});
    }
    return if (registry_hash) |h| try allocator.dupe(u8, h) else null;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/// True when `dir` is a Zig package and not a JavaScript one, so `pantry
/// publish` with no flags means this.
pub fn isZigPackageDir(allocator: std.mem.Allocator, relative: []const u8) bool {
    const dir = io_helper.realpathAlloc(allocator, relative) catch return false;
    defer allocator.free(dir);
    const zon = std.fs.path.join(allocator, &.{ dir, "build.zig.zon" }) catch return false;
    defer allocator.free(zon);
    const pkg = std.fs.path.join(allocator, &.{ dir, "package.json" }) catch return false;
    defer allocator.free(pkg);
    const has_zon = if (io_helper.accessAbsolute(zon, .{})) |_| true else |_| false;
    const has_pkg = if (io_helper.accessAbsolute(pkg, .{})) |_| true else |_| false;
    return has_zon and !has_pkg;
}

fn fail(allocator: std.mem.Allocator, comptime fmt: []const u8, args: anytype) !CommandResult {
    return .{ .exit_code = 1, .message = try std.fmt.allocPrint(allocator, fmt, args) };
}

pub fn publishZigCommand(allocator: std.mem.Allocator, path: ?[]const u8, options: Options) !CommandResult {
    const dir = io_helper.realpathAlloc(allocator, path orelse ".") catch
        return CommandResult.err(allocator, "Error: package directory not found");
    defer allocator.free(dir);
    const zon_path = try std.fs.path.join(allocator, &.{ dir, "build.zig.zon" });
    defer allocator.free(zon_path);
    const zon = io_helper.readFileAlloc(allocator, zon_path, 1024 * 1024) catch
        return fail(allocator, "Error: build.zig.zon not found in {s}", .{dir});
    defer allocator.free(zon);

    const pkg = parseManifest(allocator, zon) catch |err| return CommandResult.err(allocator, switch (err) {
        error.ZonNameMissing => "Error: Could not parse .name from build.zig.zon",
        error.ZonVersionMissing => "Error: Could not parse .version from build.zig.zon",
        else => "Error: Could not read build.zig.zon",
    });
    defer pkg.deinit(allocator);

    if (!std.mem.eql(u8, pkg.name, pkg.raw_name)) style.print("Normalized package name {s} -> {s}\n", .{ pkg.raw_name, pkg.name });
    style.print("Package: {s}@{s}\n", .{ pkg.name, pkg.version });
    const paths: []const []const u8 = if (pkg.paths.len > 0) pkg.paths else &default_paths;
    style.print("Including: ", .{});
    for (paths, 0..) |p, i| style.print("{s}{s}", .{ if (i > 0) ", " else "", p });
    style.print("\n", .{});

    const tarball = pack(allocator, dir, paths) catch |err|
        return fail(allocator, "Error: could not pack the package: {s}", .{@errorName(err)});
    defer tarball.deinit(allocator);
    const tarball_name = try std.fmt.allocPrint(allocator, "{s}-{s}.tar.gz", .{ pkg.name, pkg.version });
    defer allocator.free(tarball_name);
    const sha = sha256Hex(tarball.bytes);
    style.print("Tarball: {s} ({d:.1} KB, {d} entries, sha256 {s})\n", .{ tarball_name, @as(f64, @floatFromInt(tarball.bytes.len)) / 1024.0, tarball.members.len, &sha });

    const url = try std.fmt.allocPrint(allocator, "{s}/zig/publish", .{options.registry});
    defer allocator.free(url);

    if (options.dry_run) {
        for (tarball.members) |m| {
            if (m.directory) style.print("  {s}/\n", .{m.path}) else style.print("  {s} ({d} B)\n", .{ m.path, m.size });
        }
        style.print("[DRY RUN] Would POST {s} as {s}@{s} to {s}\n", .{ tarball_name, pkg.name, pkg.version, url });
        return .{ .exit_code = 0 };
    }

    const resolved = try token_commands.resolve(allocator, options.token, token_commands.effectiveRegistry(options.registry), token_commands.default_key);
    defer if (resolved) |t| t.deinit(allocator);
    const token = (resolved orelse return token_commands.missingCredentialError(allocator, .{ .registry = options.registry, .subject = pkg.name })).value;

    const body = try multipartBody(allocator, tarball_name, tarball.bytes, pkg.manifest);
    defer allocator.free(body);
    style.print("Publishing to {s}\n", .{url});
    const response = post(allocator, url, token, body) catch |err|
        return fail(allocator, "Error: upload failed before the registry replied: {s}", .{@errorName(err)});
    defer response.deinit(allocator);

    const outcome = try interpret(allocator, response.status, response.body);
    defer freeOutcome(allocator, outcome);
    var uploaded: ?[]const u8 = null;
    switch (outcome) {
        .already_exists => style.print("{s}@{s} already published — skipping\n", .{ pkg.name, pkg.version }),
        .rejected => |r| return fail(allocator, "Error: Publish failed (HTTP {d}): {s}", .{ r.status, r.message }),
        .published => |p| {
            style.print("Published {s}@{s}\n", .{ pkg.name, pkg.version });
            if (p.hash) |h| style.print("Hash: {s}\n", .{h});
            if (p.tarball_url) |u| style.print("URL: {s}\n", .{u});
            uploaded = &sha;
        },
    }

    if (!options.verify) return .{ .exit_code = 0 };
    const hash = verifyServed(allocator, options.registry, pkg.name, pkg.version, uploaded) catch |err|
        return fail(allocator, "Error: the published package did not verify: {s}", .{@errorName(err)});
    if (hash) |h| {
        defer allocator.free(h);
        style.print("\nbuild.zig.zon:\n  .@\"{s}\" = .{{\n      .url = \"{s}/zig/packages/{s}/{s}/tarball\",\n      .hash = \"{s}\",\n  }},\n", .{ pkg.raw_name, options.registry, pkg.name, pkg.version, h });
    }
    return .{ .exit_code = 0 };
}

// ============================================================================
// Tests
// ============================================================================

const zig_cli_zon =
    \\.{
    \\    .name = .zig_cli,
    \\    .version = "0.1.8",
    \\    .minimum_zig_version = "0.17.0-dev.1857",
    \\    .paths = .{
    \\        "build.zig",
    \\        "build.zig.zon",
    \\        "src", // the library
    \\        "examples",
    \\        "../outside",
    \\        "/etc",
    \\        "README.md",
    \\    },
    \\    .fingerprint = 0xf544320ed4f9c4d7,
    \\}
;

test "zig publish: build.zig.zon name, version and paths read as the action reads them" {
    const a = std.testing.allocator;
    const pkg = try parseManifest(a, zig_cli_zon);
    defer pkg.deinit(a);
    try std.testing.expectEqualStrings("zig_cli", pkg.raw_name);
    try std.testing.expectEqualStrings("zig-cli", pkg.name);
    // `.minimum_zig_version` is not `.version`.
    try std.testing.expectEqualStrings("0.1.8", pkg.version);
    try std.testing.expectEqual(@as(usize, 5), pkg.paths.len);
    try std.testing.expectEqualStrings("src", pkg.paths[2]);
    try std.testing.expectEqualStrings("README.md", pkg.paths[4]);
    // The manifest carries the canonical name and is otherwise unchanged.
    try std.testing.expect(std.mem.indexOf(u8, pkg.manifest, ".name = .@\"zig-cli\",") != null);
    try std.testing.expect(std.mem.indexOf(u8, pkg.manifest, ".version = \"0.1.8\"") != null);

    const quoted = try parseManifest(a, ".{ .name = .@\"zig-tls\", .version = \"1.2.3\" }");
    defer quoted.deinit(a);
    try std.testing.expectEqualStrings("zig-tls", quoted.name);
    try std.testing.expectEqual(@as(usize, 0), quoted.paths.len);
    try std.testing.expectEqualStrings(".{ .name = .@\"zig-tls\", .version = \"1.2.3\" }", quoted.manifest);

    const string_name = try parseManifest(a, ".{ .name = \"legacy\", .version = \"0.1.0\" }");
    defer string_name.deinit(a);
    try std.testing.expectEqualStrings("legacy", string_name.name);

    try std.testing.expectError(error.ZonNameMissing, parseManifest(a, ".{ .version = \"1.0.0\" }"));
    try std.testing.expectError(error.ZonVersionMissing, parseManifest(a, ".{ .name = .x }"));
}

test "zig publish: the response handling matches the action" {
    const a = std.testing.allocator;
    const exists = try interpret(a, 409, "{\"error\":\"Version already exists\"}");
    try std.testing.expect(exists == .already_exists);
    const exists_body = try interpret(a, 400, "Version already exists");
    try std.testing.expect(exists_body == .already_exists);
    const rejected = try interpret(a, 401, "{\"error\":\"Invalid token\"}");
    defer freeOutcome(a, rejected);
    try std.testing.expectEqual(@as(u16, 401), rejected.rejected.status);
    const failed = try interpret(a, 200, "{\"success\":false,\"error\":\"nope\"}");
    defer freeOutcome(a, failed);
    try std.testing.expectEqualStrings("nope", failed.rejected.message);
    const ok = try interpret(a, 201, "{\"success\":true,\"hash\":\"zig_cli-0.1.8-abc\",\"tarballUrl\":\"https://x/t\",\"artifactSha256\":\"ff\"}");
    defer freeOutcome(a, ok);
    try std.testing.expectEqualStrings("zig_cli-0.1.8-abc", ok.published.hash.?);
    try std.testing.expectEqualStrings("https://x/t", ok.published.tarball_url.?);
}

fn writeTree(root: std.Io.Dir) !void {
    try root.createDirPath(io_helper.io, "src/cli");
    try root.createDirPath(io_helper.io, "examples");
    try root.createDirPath(io_helper.io, "zig-out/bin");
    try root.writeFile(io_helper.io, .{ .sub_path = "build.zig", .data = "pub fn build(_: anytype) void {}\n" });
    try root.writeFile(io_helper.io, .{ .sub_path = "build.zig.zon", .data = zig_cli_zon });
    try root.writeFile(io_helper.io, .{ .sub_path = "src/root.zig", .data = "pub const x = 1;\n" });
    try root.writeFile(io_helper.io, .{ .sub_path = "src/cli/Parser.zig", .data = "pub const y = 2;\n" });
    try root.writeFile(io_helper.io, .{ .sub_path = "src/._root.zig", .data = "apple double" });
    try root.writeFile(io_helper.io, .{ .sub_path = "src/.DS_Store", .data = "finder" });
    try root.writeFile(io_helper.io, .{ .sub_path = "examples/basic.zig", .data = "// example\n" });
    try root.writeFile(io_helper.io, .{ .sub_path = "README.md", .data = "# zig-cli\n" });
    try root.writeFile(io_helper.io, .{ .sub_path = "zig-out/bin/cli", .data = "not in .paths" });
    // Larger than the compressor's window and the sink's first buffer.
    var big: [300 * 1024]u8 = undefined;
    var prng = std.Random.DefaultPrng.init(0x5eed);
    prng.random().bytes(&big);
    try root.writeFile(io_helper.io, .{ .sub_path = "src/cli/Big.zig", .data = &big });
}

test "zig publish: the tarball holds the .paths entries at its root and nothing else" {
    const a = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try writeTree(tmp.dir);
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = buf[0..try tmp.dir.realPath(io_helper.io, &buf)];

    const pkg = try parseManifest(a, zig_cli_zon);
    defer pkg.deinit(a);
    const tarball = try pack(a, root, pkg.paths);
    defer tarball.deinit(a);

    var names: std.ArrayList(u8) = .empty;
    defer names.deinit(a);
    for (tarball.members) |m| {
        try names.appendSlice(a, m.path);
        if (m.directory) try names.append(a, '/');
        try names.append(a, ' ');
    }
    try std.testing.expectEqualStrings("build.zig build.zig.zon src/ src/cli/ src/cli/Big.zig src/cli/Parser.zig src/root.zig examples/ examples/basic.zig README.md ", names.items);

    // The bytes are a gzip tarball whose entries sit at the root.
    var input: std.Io.Reader = .fixed(tarball.bytes);
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var decompress: std.compress.flate.Decompress = .init(&input, .gzip, &window);
    var file_name: [std.fs.max_path_bytes]u8 = undefined;
    var link_name: [std.fs.max_path_bytes]u8 = undefined;
    var it: std.tar.Iterator = .init(&decompress.reader, .{ .file_name_buffer = &file_name, .link_name_buffer = &link_name });
    var count: usize = 0;
    while (try it.next()) |entry| : (count += 1) {
        try std.testing.expect(!std.mem.startsWith(u8, entry.name, "/"));
        try std.testing.expect(std.mem.indexOf(u8, entry.name, "._") == null);
    }
    try std.testing.expectEqual(tarball.members.len, count);

    // A path .paths names but the tree lacks is an error, as tar's was.
    try std.testing.expectError(error.PackagePathNotFound, pack(a, root, &.{ "src", "missing.zig" }));
}

test "zig publish: the request carries the tarball, the canonical manifest and the token" {
    const a = std.testing.allocator;
    const pkg = try parseManifest(a, zig_cli_zon);
    defer pkg.deinit(a);
    const body = try multipartBody(a, "zig-cli-0.1.8.tar.gz", "\x1f\x8bTARBALL", pkg.manifest);
    defer a.free(body);
    try std.testing.expect(std.mem.indexOf(u8, body, "name=\"tarball\"; filename=\"zig-cli-0.1.8.tar.gz\"\r\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\x1f\x8bTARBALL\r\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "name=\"manifest\"\r\n\r\n.{\n    .name = .@\"zig-cli\",") != null);
    try std.testing.expect(std.mem.endsWith(u8, body, "--" ++ boundary ++ "--\r\n"));
}

/// A registry that answers one POST, keeping what it was sent.
const FakeRegistry = struct {
    server: std.Io.net.Server,
    response: []const u8,
    request: std.ArrayList(u8) = .empty,

    fn serve(self: *@This()) !void {
        const connection = try self.server.accept(std.testing.io);
        defer connection.close(std.testing.io);
        var head: [16 * 1024]u8 = undefined;
        var reader = connection.reader(std.testing.io, &head);
        var length: usize = 0;
        while (true) {
            const line = try reader.interface.takeDelimiterInclusive('\n');
            try self.request.appendSlice(std.testing.allocator, line);
            if (std.ascii.startsWithIgnoreCase(line, "content-length:"))
                length = try std.fmt.parseInt(usize, std.mem.trim(u8, line["content-length:".len..], " \r\n"), 10);
            if (std.mem.eql(u8, line, "\r\n")) break;
        }
        const body = try std.testing.allocator.alloc(u8, length);
        defer std.testing.allocator.free(body);
        try reader.interface.readSliceAll(body);
        try self.request.appendSlice(std.testing.allocator, body);
        var bytes: [1024]u8 = undefined;
        var writer = connection.writer(std.testing.io, &bytes);
        try writer.interface.writeAll(self.response);
        try writer.interface.flush();
    }
};

fn publishAgainst(response: []const u8, expected_exit: u8) !void {
    const a = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try writeTree(tmp.dir);
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = buf[0..try tmp.dir.realPath(io_helper.io, &buf)];

    const address = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
    var fake: FakeRegistry = .{ .server = try address.listen(std.testing.io, .{ .reuse_address = true }), .response = response };
    defer fake.server.deinit(std.testing.io);
    defer fake.request.deinit(a);
    var serving = try std.testing.io.concurrent(FakeRegistry.serve, .{&fake});
    defer serving.cancel(std.testing.io) catch {};
    const registry = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{fake.server.socket.address.getPort()});
    defer a.free(registry);

    var result = try publishZigCommand(a, root, .{ .registry = registry, .token = "test-token", .verify = false });
    defer result.deinit(a);
    try std.testing.expectEqual(expected_exit, result.exit_code);
    try serving.await(std.testing.io);

    const request = fake.request.items;
    try std.testing.expect(std.mem.startsWith(u8, request, "POST /zig/publish HTTP/1.1\r\n"));
    try std.testing.expect(std.ascii.findIgnoreCase(request, "authorization: Bearer test-token\r\n") != null);
    try std.testing.expect(std.ascii.findIgnoreCase(request, "content-type: multipart/form-data; boundary=" ++ boundary ++ "\r\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, request, "filename=\"zig-cli-0.1.8.tar.gz\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, request, ".name = .@\"zig-cli\",") != null);
}

test "zig publish: a local registry receives the package and its answer is honoured" {
    try publishAgainst("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 97\r\nConnection: close\r\n\r\n{\"success\":true,\"hash\":\"zig_cli-0.1.8-AAAA\",\"tarballUrl\":\"http://x/zig/packages/zig-cli/0.1.8/t\"}", 0);
    // An existing version is a skip, not a failure.
    try publishAgainst("HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: 34\r\nConnection: close\r\n\r\n{\"error\":\"Version already exists\"}", 0);
    try publishAgainst("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 25\r\nConnection: close\r\n\r\n{\"error\":\"Invalid token\"}", 1);
}
