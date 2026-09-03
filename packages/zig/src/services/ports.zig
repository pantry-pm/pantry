//! Per-project service port assignment.
//!
//! Until this existed, `getServiceConfig` answered every caller with
//! `Services.getDefaultPort(name)` — the same number for every project on the
//! machine. Two checkouts that both run postgres both got 5432; two that run
//! typesense both got 8108. Whichever started first won the port and the
//! other could never bind.
//!
//! The second one did not fail loudly. It was installed with `KeepAlive`, so
//! the process manager restarted it every ten seconds forever, and the health
//! check that was supposed to catch this probed the same default port — where
//! the *first* project's server answered, so the start reported healthy while
//! its own service was dead. A worktree of one project spent days restarting
//! against another project's typesense and wrote 78 GB of shutdown banners
//! doing it.
//!
//! So a port is now a per-project assignment, recorded in
//! `~/.local/share/pantry/ports.json`, and every entry point that resolves a
//! service config goes through here.
//!
//! Two properties matter more than the allocation policy itself:
//!
//!   * **Assignments are stable.** A project's postgres keeps the port it was
//!     given, across restarts and across pantry upgrades, because connection
//!     strings in `.env` files and application config point at it. Allocation
//!     happens once; every later resolve is a lookup.
//!   * **Existing units are adopted, not renumbered.** The first resolve for a
//!     project that already has an installed unit takes the port out of that
//!     unit. Upgrading pantry must not move the ports of setups that work.

const std = @import("std");
const io_helper = @import("../io_helper.zig");
const platform = @import("platform.zig");
const definitions = @import("definitions.zig");

/// Distance between successive candidates for the same service. Wide enough
/// that a service occupying a small span of ports (typesense takes its API
/// port and the one below it) cannot reach into the next project's block, and
/// round enough that the resulting numbers stay readable: 5432, 5532, 5632.
pub const stride: u16 = 100;

/// Give up rather than scan the whole port space.
const max_attempts: u16 = 64;

pub const Assignment = struct {
    project: []const u8,
    service: []const u8,
    port: u16,
    /// The project directory, for `pantry services:ports` to show and for
    /// stale-entry reaping. Absent in entries written before it was recorded.
    root: ?[]const u8 = null,
};

/// Is `port` bindable on the loopback interface right now?
///
/// A bind probe rather than a connect probe: connect only sees a service that
/// is currently accepting, and the question here is whether *we* could take
/// the port. This also catches ports held by processes pantry knows nothing
/// about — a system postgres, a container, an editor's dev server.
pub fn isPortFree(port: u16) bool {
    const c = std.c;
    const fd = c.socket(c.AF.INET, c.SOCK.STREAM, 0);
    if (fd < 0) return true; // Can't tell; don't block allocation on it.
    defer _ = c.close(fd);

    var addr = std.mem.zeroes(c.sockaddr.in);
    addr.family = c.AF.INET;
    addr.port = std.mem.nativeToBig(u16, port);
    addr.addr = std.mem.nativeToBig(u32, 0x7f000001); // 127.0.0.1

    return c.bind(fd, @ptrCast(&addr), @sizeOf(c.sockaddr.in)) == 0;
}

/// `~/.local/share/pantry/ports.json`, caller-owned.
fn registryPath(allocator: std.mem.Allocator) ?[]u8 {
    const home = io_helper.getEnvVarOwned(allocator, "HOME") catch return null;
    defer allocator.free(home);
    const dir = std.fmt.allocPrint(allocator, "{s}/.local/share/pantry", .{home}) catch return null;
    defer allocator.free(dir);
    io_helper.makePath(dir) catch {};
    return std.fmt.allocPrint(allocator, "{s}/ports.json", .{dir}) catch null;
}

pub const Registry = struct {
    allocator: std.mem.Allocator,
    path: ?[]u8,
    assignments: std.ArrayList(Assignment),

    pub fn load(allocator: std.mem.Allocator) Registry {
        return loadFrom(allocator, registryPath(allocator));
    }

    /// `path` is taken over by the returned registry (freed by `deinit`).
    pub fn loadFrom(allocator: std.mem.Allocator, path_opt: ?[]u8) Registry {
        var self = Registry{
            .allocator = allocator,
            .path = path_opt,
            .assignments = .empty,
        };

        const path = self.path orelse return self;
        const content = io_helper.readFileAllocAbsolute(allocator, path, 4 * 1024 * 1024) catch return self;
        defer allocator.free(content);

        const parsed = std.json.parseFromSlice(std.json.Value, allocator, content, .{}) catch {
            // A registry we cannot read is not an empty registry. Starting
            // fresh here would hand out ports that other projects already
            // hold and then overwrite the only record of them, so keep the
            // file for inspection instead of destroying it.
            const aside = std.fmt.allocPrint(allocator, "{s}.corrupt", .{path}) catch return self;
            defer allocator.free(aside);
            io_helper.rename(path, aside) catch {};
            return self;
        };
        defer parsed.deinit();

        const root_obj = switch (parsed.value) {
            .object => |o| o,
            else => return self,
        };
        const list = switch (root_obj.get("assignments") orelse return self) {
            .array => |a| a,
            else => return self,
        };

        for (list.items) |item| {
            const obj = switch (item) {
                .object => |o| o,
                else => continue,
            };
            const project = switch (obj.get("project") orelse continue) {
                .string => |s| s,
                else => continue,
            };
            const service = switch (obj.get("service") orelse continue) {
                .string => |s| s,
                else => continue,
            };
            const port = switch (obj.get("port") orelse continue) {
                .integer => |i| if (i > 0 and i <= 65535) @as(u16, @intCast(i)) else continue,
                else => continue,
            };
            const proj_root: ?[]const u8 = switch (obj.get("root") orelse std.json.Value{ .null = {} }) {
                .string => |s| allocator.dupe(u8, s) catch null,
                else => null,
            };

            self.assignments.append(allocator, .{
                .project = allocator.dupe(u8, project) catch continue,
                .service = allocator.dupe(u8, service) catch continue,
                .port = port,
                .root = proj_root,
            }) catch {};
        }

        return self;
    }

    pub fn deinit(self: *Registry) void {
        for (self.assignments.items) |a| {
            self.allocator.free(a.project);
            self.allocator.free(a.service);
            if (a.root) |r| self.allocator.free(r);
        }
        self.assignments.deinit(self.allocator);
        if (self.path) |p| self.allocator.free(p);
    }

    /// Write via a temp file and rename, so a crash mid-write cannot leave a
    /// truncated registry — losing it would renumber every project's ports.
    pub fn save(self: *Registry) !void {
        const path = self.path orelse return;

        var buf = std.ArrayList(u8).empty;
        defer buf.deinit(self.allocator);

        try buf.appendSlice(self.allocator, "{\n  \"version\": 1,\n  \"assignments\": [\n");
        for (self.assignments.items, 0..) |a, i| {
            const sep = if (i + 1 < self.assignments.items.len) "," else "";
            // `std.json.fmt` emits the surrounding quotes itself — wrapping
            // its output in another pair produces `""path""`, which does not
            // parse, which silently empties the registry on the next load.
            if (a.root) |r| {
                const line = try std.fmt.allocPrint(
                    self.allocator,
                    "    {{\"project\": {f}, \"service\": {f}, \"port\": {d}, \"root\": {f}}}{s}\n",
                    .{ std.json.fmt(a.project, .{}), std.json.fmt(a.service, .{}), a.port, std.json.fmt(r, .{}), sep },
                );
                defer self.allocator.free(line);
                try buf.appendSlice(self.allocator, line);
            } else {
                const line = try std.fmt.allocPrint(
                    self.allocator,
                    "    {{\"project\": {f}, \"service\": {f}, \"port\": {d}}}{s}\n",
                    .{ std.json.fmt(a.project, .{}), std.json.fmt(a.service, .{}), a.port, sep },
                );
                defer self.allocator.free(line);
                try buf.appendSlice(self.allocator, line);
            }
        }
        try buf.appendSlice(self.allocator, "  ]\n}\n");

        const tmp = try std.fmt.allocPrint(self.allocator, "{s}.tmp", .{path});
        defer self.allocator.free(tmp);
        {
            const file = try io_helper.createFileAbsolute(tmp, .{});
            defer io_helper.closeFile(file);
            try io_helper.writeAllToFile(file, buf.items);
        }
        try io_helper.rename(tmp, path);
    }

    pub fn portFor(self: *const Registry, project: []const u8, service: []const u8) ?u16 {
        for (self.assignments.items) |a| {
            if (std.mem.eql(u8, a.project, project) and std.mem.eql(u8, a.service, service)) return a.port;
        }
        return null;
    }

    /// Is `port` claimed by some assignment other than (project, service)?
    /// Any other assignment counts, including one of this project's own other
    /// services — two services in one project sharing a default (redis, keydb
    /// and dragonflydb all default to 6379) collide just as surely as two
    /// projects do.
    fn claimedByOther(self: *const Registry, port: u16, project: []const u8, service: []const u8) bool {
        for (self.assignments.items) |a| {
            if (a.port != port) continue;
            if (std.mem.eql(u8, a.project, project) and std.mem.eql(u8, a.service, service)) continue;
            return true;
        }
        return false;
    }

    pub fn put(self: *Registry, project: []const u8, service: []const u8, port: u16, root: ?[]const u8) !void {
        for (self.assignments.items) |*a| {
            if (std.mem.eql(u8, a.project, project) and std.mem.eql(u8, a.service, service)) {
                a.port = port;
                if (root) |r| {
                    if (a.root) |old| self.allocator.free(old);
                    a.root = try self.allocator.dupe(u8, r);
                }
                return;
            }
        }
        try self.assignments.append(self.allocator, .{
            .project = try self.allocator.dupe(u8, project),
            .service = try self.allocator.dupe(u8, service),
            .port = port,
            .root = if (root) |r| try self.allocator.dupe(u8, r) else null,
        });
    }

    /// Drop one project's assignment for one service. Returns whether there
    /// was anything to drop.
    pub fn releaseService(self: *Registry, project: []const u8, service: []const u8) bool {
        for (self.assignments.items, 0..) |a, i| {
            if (!std.mem.eql(u8, a.project, project)) continue;
            if (!std.mem.eql(u8, a.service, service)) continue;
            self.allocator.free(a.project);
            self.allocator.free(a.service);
            if (a.root) |r| self.allocator.free(r);
            _ = self.assignments.orderedRemove(i);
            return true;
        }
        return false;
    }

    /// Drop every assignment for a project. Called when its units are pruned,
    /// so a deleted project's ports return to the pool.
    pub fn releaseProject(self: *Registry, project: []const u8) usize {
        var removed: usize = 0;
        var i: usize = 0;
        while (i < self.assignments.items.len) {
            const a = self.assignments.items[i];
            if (std.mem.eql(u8, a.project, project)) {
                self.allocator.free(a.project);
                self.allocator.free(a.service);
                if (a.root) |r| self.allocator.free(r);
                _ = self.assignments.orderedRemove(i);
                removed += 1;
            } else {
                i += 1;
            }
        }
        return removed;
    }
};

/// Every port a service occupies when assigned `port`.
///
/// Most services take one. Typesense takes two, and the allocator has to know
/// about the whole span or it will hand out a candidate whose neighbour is
/// already someone else's. The second port comes from the service definition
/// rather than being restated here — it is the same derivation the generated
/// command uses, and the two drifting apart is precisely how the original
/// collision hid.
pub fn span(service: []const u8, port: u16) [2]?u16 {
    return .{ port, definitions.Services.auxiliaryPort(service, port) };
}

/// Does any *other* assignment hold a port in this candidate's span?
///
/// Registry-only, no host probing — this is the question adoption asks. Five
/// projects on this machine each have a postgres unit that says 5432, because
/// that is what every project was told before ports were assigned. Exactly one
/// of them can keep it; adopting blindly would write the collision into the
/// registry and change nothing.
fn spanClaimedByOther(reg: *const Registry, project: []const u8, service: []const u8, port: u16) bool {
    for (span(service, port)) |maybe| {
        const p = maybe orelse continue;
        if (reg.claimedByOther(p, project, service)) return true;
    }
    return false;
}

fn spanFreeOnHost(service: []const u8, port: u16) bool {
    for (span(service, port)) |maybe| {
        const p = maybe orelse continue;
        if (!isPortFree(p)) return false;
    }
    return true;
}

fn candidateUsable(reg: *const Registry, project: []const u8, service: []const u8, port: u16) bool {
    if (spanClaimedByOther(reg, project, service, port)) return false;
    return spanFreeOnHost(service, port);
}

/// Is this project's own service the thing currently holding the port?
///
/// The distinction adoption turns on. A busy port under a project whose
/// service is *running* is that project's own healthy server — renumbering it
/// would break the connection strings pointing at it. A busy port under a
/// project whose service is *not* running belongs to somebody else, and
/// adopting it would recreate the crash loop this whole mechanism exists to
/// prevent.
fn ownServiceIsRunning(allocator: std.mem.Allocator, project: []const u8, service: []const u8) bool {
    var controller = platform.ServiceController.init(allocator);
    return controller.isRunning(service, project) catch false;
}

/// The port already baked into this project's installed unit, if it has one.
///
/// This is the migration path. A machine that has been running for months has
/// units, `.env` files and application config all agreeing on a port that no
/// registry knows about. Adopting it on first resolve means turning port
/// assignment on changes nothing for setups that already work; only a *new*
/// project, or one that genuinely collides, gets a different number.
pub fn installedPort(allocator: std.mem.Allocator, project: []const u8, service: []const u8) ?u16 {
    var controller = platform.ServiceController.init(allocator);
    const unit = controller.unitPath(service, project) catch return null;
    defer allocator.free(unit);

    io_helper.accessAbsolute(unit, .{}) catch return null;

    const commands = @import("../cli/commands/services.zig");
    return commands.portFromInstalledUnit(allocator, unit);
}

/// Resolve — and if necessary allocate — the port for one project's service.
///
/// In order:
///   1. An existing assignment. Ports must not move under a running project.
///   2. The port in an already-installed unit, adopted into the registry.
///   3. The service's default, when nothing else holds it.
///   4. The default plus a multiple of `stride`, first one whose whole span
///      is free both in the registry and on the host.
///
/// Falls back to the default if the registry cannot be written — a machine
/// with an unwritable home should still be able to start a service, and a
/// default port is exactly the behaviour that preceded this function.
pub fn resolve(
    allocator: std.mem.Allocator,
    project: []const u8,
    project_root: ?[]const u8,
    service: []const u8,
    default_port: u16,
) u16 {
    var reg = Registry.load(allocator);
    defer reg.deinit();

    if (reg.portFor(project, service)) |assigned| return assigned;

    if (installedPort(allocator, project, service)) |existing| {
        // Adopt only what this project can actually still have. Another
        // project already assigned that port means this unit's number was
        // never going to work; a busy port that this project is not the one
        // running means the same thing.
        const adoptable = !spanClaimedByOther(&reg, project, service, existing) and
            (spanFreeOnHost(service, existing) or ownServiceIsRunning(allocator, project, service));

        if (adoptable) {
            reg.put(project, service, existing, project_root) catch return existing;
            reg.save() catch {};
            return existing;
        }
        // Otherwise fall through and allocate a port it can hold.
    }

    var attempt: u16 = 0;
    while (attempt < max_attempts) : (attempt += 1) {
        const candidate = std.math.add(u16, default_port, stride * attempt) catch break;
        if (!candidateUsable(&reg, project, service, candidate)) continue;

        reg.put(project, service, candidate, project_root) catch return candidate;
        reg.save() catch {};
        return candidate;
    }

    return default_port;
}

/// Record a port the user pinned explicitly (`--port`, or a port declared in
/// deps.yaml), so it shows up alongside allocated ones and so nothing else is
/// later handed the same number.
pub fn reserve(
    allocator: std.mem.Allocator,
    project: []const u8,
    project_root: ?[]const u8,
    service: []const u8,
    port: u16,
) void {
    var reg = Registry.load(allocator);
    defer reg.deinit();
    reg.put(project, service, port, project_root) catch return;
    reg.save() catch {};
}

/// Drop one service's assignment. Returns whether one was released.
pub fn releaseOne(allocator: std.mem.Allocator, project: []const u8, service: []const u8) bool {
    var reg = Registry.load(allocator);
    defer reg.deinit();
    const released = reg.releaseService(project, service);
    if (released) reg.save() catch {};
    return released;
}

/// Drop a project's assignments. Returns how many were released.
pub fn release(allocator: std.mem.Allocator, project: []const u8) usize {
    var reg = Registry.load(allocator);
    defer reg.deinit();
    const removed = reg.releaseProject(project);
    if (removed > 0) reg.save() catch {};
    return removed;
}

test "span covers the typesense peering port" {
    const s = span("typesense", 8108);
    try std.testing.expectEqual(@as(?u16, 8108), s[0]);
    try std.testing.expectEqual(@as(?u16, 8107), s[1]);

    const p = span("postgres", 5432);
    try std.testing.expectEqual(@as(?u16, 5432), p[0]);
    try std.testing.expectEqual(@as(?u16, null), p[1]);
}

test "claimedByOther ignores the pair being resolved" {
    const allocator = std.testing.allocator;
    var reg = Registry{ .allocator = allocator, .path = null, .assignments = .empty };
    defer reg.deinit();

    try reg.put("aaaaaaaa", "postgres", 5432, null);

    // Its own assignment is not a conflict with itself.
    try std.testing.expect(!reg.claimedByOther(5432, "aaaaaaaa", "postgres"));
    // Another project wanting the same port is.
    try std.testing.expect(reg.claimedByOther(5432, "bbbbbbbb", "postgres"));
    // So is the same project's *other* service — redis, keydb and
    // dragonflydb all default to 6379.
    try std.testing.expect(reg.claimedByOther(5432, "aaaaaaaa", "redis"));
}

test "put replaces rather than duplicating" {
    const allocator = std.testing.allocator;
    var reg = Registry{ .allocator = allocator, .path = null, .assignments = .empty };
    defer reg.deinit();

    try reg.put("aaaaaaaa", "postgres", 5432, "/tmp/a");
    try reg.put("aaaaaaaa", "postgres", 5532, "/tmp/a");

    try std.testing.expectEqual(@as(usize, 1), reg.assignments.items.len);
    try std.testing.expectEqual(@as(?u16, 5532), reg.portFor("aaaaaaaa", "postgres"));
}

test "releaseProject drops only that project" {
    const allocator = std.testing.allocator;
    var reg = Registry{ .allocator = allocator, .path = null, .assignments = .empty };
    defer reg.deinit();

    try reg.put("aaaaaaaa", "postgres", 5432, null);
    try reg.put("aaaaaaaa", "redis", 6379, null);
    try reg.put("bbbbbbbb", "postgres", 5532, null);

    try std.testing.expectEqual(@as(usize, 2), reg.releaseProject("aaaaaaaa"));
    try std.testing.expectEqual(@as(usize, 1), reg.assignments.items.len);
    try std.testing.expectEqual(@as(?u16, 5532), reg.portFor("bbbbbbbb", "postgres"));
}

test "a second project stops taking the first project's port" {
    const allocator = std.testing.allocator;
    var reg = Registry{ .allocator = allocator, .path = null, .assignments = .empty };
    defer reg.deinit();

    // The exact shape of the bug: erbamarkets holds typesense's default, and
    // a worktree of another project asks for typesense too.
    try reg.put("b95aed13", "typesense", 8108, null);

    try std.testing.expect(!candidateUsable(&reg, "86fa9b25", "typesense", 8108));
    // 8208's span is 8208/8207 — clear of 8108.
    try std.testing.expect(!reg.claimedByOther(8208, "86fa9b25", "typesense"));
    try std.testing.expect(!reg.claimedByOther(8207, "86fa9b25", "typesense"));
}

test "a candidate whose peering port is claimed is rejected" {
    const allocator = std.testing.allocator;
    var reg = Registry{ .allocator = allocator, .path = null, .assignments = .empty };
    defer reg.deinit();

    // Something already sits on 8207. A typesense assigned 8208 would derive
    // its peering port as 8207 and collide — the failure that the whole span
    // check exists to prevent.
    try reg.put("cccccccc", "someservice", 8207, null);

    try std.testing.expect(!candidateUsable(&reg, "86fa9b25", "typesense", 8208));
}

test "assignments survive a save/load round trip" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const dir_path = path_buf[0..try tmp.dir.realPath(io_helper.io, &path_buf)];
    const file_path = try std.fmt.allocPrint(allocator, "{s}/ports.json", .{dir_path});

    {
        var reg = Registry.loadFrom(allocator, try allocator.dupe(u8, file_path));
        defer reg.deinit();
        try reg.put("b95aed13", "typesense", 8108, "/Users/x/Code/erbamarkets");
        try reg.put("86fa9b25", "postgres", 5532, null);
        try reg.save();
    }

    var reloaded = Registry.loadFrom(allocator, file_path);
    defer reloaded.deinit();

    try std.testing.expectEqual(@as(usize, 2), reloaded.assignments.items.len);
    try std.testing.expectEqual(@as(?u16, 8108), reloaded.portFor("b95aed13", "typesense"));
    try std.testing.expectEqual(@as(?u16, 5532), reloaded.portFor("86fa9b25", "postgres"));
    try std.testing.expectEqualStrings("/Users/x/Code/erbamarkets", reloaded.assignments.items[0].root.?);
}

test "a root needing JSON escaping round trips" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const dir_path = path_buf[0..try tmp.dir.realPath(io_helper.io, &path_buf)];
    const file_path = try std.fmt.allocPrint(allocator, "{s}/ports.json", .{dir_path});

    const awkward = "/Users/x/Code/a \"quoted\" dir\\with backslash";
    {
        var reg = Registry.loadFrom(allocator, try allocator.dupe(u8, file_path));
        defer reg.deinit();
        try reg.put("aaaaaaaa", "redis", 6379, awkward);
        try reg.save();
    }

    var reloaded = Registry.loadFrom(allocator, file_path);
    defer reloaded.deinit();

    try std.testing.expectEqual(@as(usize, 1), reloaded.assignments.items.len);
    try std.testing.expectEqualStrings(awkward, reloaded.assignments.items[0].root.?);
}

test "an unreadable registry is preserved, not silently emptied" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const dir_path = path_buf[0..try tmp.dir.realPath(io_helper.io, &path_buf)];
    const file_path = try std.fmt.allocPrint(allocator, "{s}/ports.json", .{dir_path});
    defer allocator.free(file_path);

    {
        const f = try io_helper.createFileAbsolute(file_path, .{});
        defer io_helper.closeFile(f);
        try io_helper.writeAllToFile(f, "{ not json at all ");
    }

    {
        var reg = Registry.loadFrom(allocator, try allocator.dupe(u8, file_path));
        defer reg.deinit();
        try std.testing.expectEqual(@as(usize, 0), reg.assignments.items.len);
    }

    // Moved aside rather than overwritten, so the assignments it held can be
    // recovered by hand.
    const aside = try std.fmt.allocPrint(allocator, "{s}.corrupt", .{file_path});
    defer allocator.free(aside);
    const stat = try io_helper.statFile(aside);
    try std.testing.expect(stat.size > 0);
}

test "only the first project adopts a port five units all claim" {
    const allocator = std.testing.allocator;
    var reg = Registry{ .allocator = allocator, .path = null, .assignments = .empty };
    defer reg.deinit();

    // Every project on the machine has a postgres unit saying 5432, because
    // that is what each was told before ports were assigned.
    try std.testing.expect(!spanClaimedByOther(&reg, "aaaaaaaa", "postgres", 5432));
    try reg.put("aaaaaaaa", "postgres", 5432, null);

    // The next four cannot adopt it, whatever their units say.
    try std.testing.expect(spanClaimedByOther(&reg, "bbbbbbbb", "postgres", 5432));
    try std.testing.expect(spanClaimedByOther(&reg, "cccccccc", "postgres", 5432));

    // And they land on distinct ports instead.
    try std.testing.expect(!spanClaimedByOther(&reg, "bbbbbbbb", "postgres", 5532));
    try reg.put("bbbbbbbb", "postgres", 5532, null);
    try std.testing.expect(spanClaimedByOther(&reg, "cccccccc", "postgres", 5532));
    try std.testing.expect(!spanClaimedByOther(&reg, "cccccccc", "postgres", 5632));
}

test "re-resolving a project returns the same port" {
    const allocator = std.testing.allocator;
    var reg = Registry{ .allocator = allocator, .path = null, .assignments = .empty };
    defer reg.deinit();

    // Stability is the property application config depends on: a DATABASE_URL
    // written today must still point at the right server next week.
    try reg.put("aaaaaaaa", "postgres", 5532, null);
    try std.testing.expectEqual(@as(?u16, 5532), reg.portFor("aaaaaaaa", "postgres"));
    try std.testing.expectEqual(@as(?u16, 5532), reg.portFor("aaaaaaaa", "postgres"));
    // A project's own assignment never reads as a conflict with itself.
    try std.testing.expect(!spanClaimedByOther(&reg, "aaaaaaaa", "postgres", 5532));
}

test "releaseService drops one pair, not the project" {
    const allocator = std.testing.allocator;
    var reg = Registry{ .allocator = allocator, .path = null, .assignments = .empty };
    defer reg.deinit();

    try reg.put("d298bb3b", "postgres", 5532, "/Users/x/Code/pantry");
    try reg.put("d298bb3b", "redis", 6379, "/Users/x/Code/pantry");

    // Removing a project's postgres must not take its redis with it — the
    // project is alive, only that one service is finished with.
    try std.testing.expect(reg.releaseService("d298bb3b", "postgres"));
    try std.testing.expectEqual(@as(?u16, null), reg.portFor("d298bb3b", "postgres"));
    try std.testing.expectEqual(@as(?u16, 6379), reg.portFor("d298bb3b", "redis"));

    // Releasing again is a no-op rather than an error.
    try std.testing.expect(!reg.releaseService("d298bb3b", "postgres"));
}

test "a released port is available to the next project" {
    const allocator = std.testing.allocator;
    var reg = Registry{ .allocator = allocator, .path = null, .assignments = .empty };
    defer reg.deinit();

    try reg.put("aaaaaaaa", "postgres", 5532, null);
    try std.testing.expect(spanClaimedByOther(&reg, "bbbbbbbb", "postgres", 5532));

    _ = reg.releaseService("aaaaaaaa", "postgres");
    try std.testing.expect(!spanClaimedByOther(&reg, "bbbbbbbb", "postgres", 5532));
}
