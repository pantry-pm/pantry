//! Deterministic ownership of `pantry/.bin` names (pantry-pm/pantry#235).
//!
//! Two installed npm packages can declare the same `bin` name. The npm shims
//! are written from the parallel download phase, so whichever package was
//! shimmed last used to own `pantry/.bin/<name>` - thread scheduling, not the
//! project, decided which program a bare command ran. In every Stacks project
//! `buddy` is declared by both `@stacksjs/buddy` (the framework CLI, reached
//! through the production dependency `stacks`) and `@buddysh/buddy` (a CI bot,
//! reached only through the devDependency `better-dx`), and `buddy dev` could
//! start the bot.
//!
//! After installing, `resolveBinCollisions` walks the project's dependency
//! graph and gives each contested name to one provider, by these rules:
//!
//!   1. the project's own workspace packages and direct dependencies beat
//!      transitive dependencies;
//!   2. a package reachable through `dependencies` beats one reachable only
//!      through `devDependencies` / `optionalDependencies`;
//!   3. the shallower dependency depth wins, then the package name.
//!
//! Install order never decides. A shim that belongs to none of the contending
//! npm packages (a system package's binary, say) is left alone.

const std = @import("std");
const io_helper = @import("../io_helper.zig");
const style = @import("../cli/style.zig");
const symlink = @import("symlink.zig");

/// One package's claim on a bin name.
pub const Provider = struct {
    /// npm package name.
    package: []const u8,
    /// Absolute path of the executable the shim should run.
    target: []const u8,
    /// One of the project's own workspace packages.
    workspace: bool = false,
    /// A workspace package or a direct dependency of the project (rule 1).
    own: bool = false,
    /// Reachable from the project through `dependencies` edges only (rule 2).
    prod: bool = false,
    /// Dependency depth: 0 for workspace packages, 1 for direct dependencies.
    depth: u32 = std.math.maxInt(u32),
};

/// Does `a` win `b`'s bin name? A strict total order over distinct packages.
pub fn outranks(a: Provider, b: Provider) bool {
    if (a.own != b.own) return a.own;
    if (a.prod != b.prod) return a.prod;
    if (a.depth != b.depth) return a.depth < b.depth;
    return std.mem.order(u8, a.package, b.package) == .lt;
}

/// Index of the provider that owns the name. `providers` must be non-empty.
pub fn pickOwner(providers: []const Provider) usize {
    var best: usize = 0;
    for (providers[1..], 1..) |candidate, i| {
        if (outranks(candidate, providers[best])) best = i;
    }
    return best;
}

/// Why the owner won, for the collision warning.
fn ownerReason(owner: Provider) []const u8 {
    if (owner.workspace) return "workspace package";
    if (owner.own) return "direct dependency";
    if (owner.prod) return "reached through dependencies";
    return "shallowest dependency";
}

const Manifest = struct {
    /// `dependencies` - production edges.
    prod_deps: []const []const u8 = &.{},
    /// `devDependencies`, `optionalDependencies` (and, for the project's own
    /// manifests, also counted as direct dependencies).
    other_deps: []const []const u8 = &.{},
    /// `peerDependencies`: a direct production requirement when declared by
    /// the project itself; not followed transitively.
    peer_deps: []const []const u8 = &.{},
    /// bin name -> path relative to the package directory.
    bins: []const Bin = &.{},
    name: ?[]const u8 = null,
};

const Bin = struct { name: []const u8, rel_path: []const u8 };

fn depNames(arena: std.mem.Allocator, obj: std.json.ObjectMap, field: []const u8) ![]const []const u8 {
    const val = obj.get(field) orelse return &.{};
    if (val != .object) return &.{};
    var names = std.ArrayList([]const u8).empty;
    var it = val.object.iterator();
    while (it.next()) |entry| try names.append(arena, try arena.dupe(u8, entry.key_ptr.*));
    return names.items;
}

fn binName(raw: []const u8) ?[]const u8 {
    const name = if (std.mem.lastIndexOfScalar(u8, raw, '/')) |idx| raw[idx + 1 ..] else raw;
    if (name.len == 0 or std.mem.eql(u8, name, ".") or std.mem.eql(u8, name, "..")) return null;
    return name;
}

fn readManifest(arena: std.mem.Allocator, path: []const u8) ?Manifest {
    const content = io_helper.readFileAlloc(arena, path, 4 * 1024 * 1024) catch return null;
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena, content, .{}) catch return null;
    if (parsed != .object) return null;
    const obj = parsed.object;

    var manifest = Manifest{};
    manifest.prod_deps = depNames(arena, obj, "dependencies") catch return null;
    const dev = depNames(arena, obj, "devDependencies") catch return null;
    const optional = depNames(arena, obj, "optionalDependencies") catch return null;
    manifest.other_deps = std.mem.concat(arena, []const u8, &.{ dev, optional }) catch return null;
    manifest.peer_deps = depNames(arena, obj, "peerDependencies") catch return null;
    if (obj.get("name")) |n| {
        if (n == .string) manifest.name = n.string;
    }

    var bins = std.ArrayList(Bin).empty;
    if (obj.get("bin")) |bin| switch (bin) {
        .string => |rel| if (manifest.name) |pkg_name| {
            if (binName(pkg_name)) |name| bins.append(arena, .{ .name = name, .rel_path = rel }) catch return null;
        },
        .object => |map| {
            var it = map.iterator();
            while (it.next()) |entry| {
                if (entry.value_ptr.* != .string) continue;
                const name = binName(entry.key_ptr.*) orelse continue;
                bins.append(arena, .{ .name = name, .rel_path = entry.value_ptr.string }) catch return null;
            }
        },
        else => {},
    };
    manifest.bins = bins.items;
    return manifest;
}

const Node = struct {
    workspace: bool = false,
    own: bool = false,
    prod: bool = false,
    depth: u32 = std.math.maxInt(u32),
};

const Graph = struct {
    arena: std.mem.Allocator,
    modules_root: []const u8,
    nodes: std.StringArrayHashMapUnmanaged(Node) = .empty,
    manifests: std.StringHashMapUnmanaged(?Manifest) = .empty,

    fn node(self: *Graph, name: []const u8) !*Node {
        const gop = try self.nodes.getOrPut(self.arena, name);
        if (!gop.found_existing) gop.value_ptr.* = .{};
        return gop.value_ptr;
    }

    /// The installed package's manifest (`<modules_root>/<name>/package.json`).
    fn manifest(self: *Graph, name: []const u8) ?Manifest {
        if (self.manifests.get(name)) |cached| return cached;
        const path = std.fmt.allocPrint(self.arena, "{s}/{s}/package.json", .{ self.modules_root, name }) catch return null;
        const loaded = readManifest(self.arena, path);
        self.manifests.put(self.arena, name, loaded) catch {};
        return loaded;
    }
};

/// Workspace globs from the root manifest (`workspaces: [...]` or
/// `workspaces: { packages: [...] }`), negations dropped.
fn workspacePatterns(arena: std.mem.Allocator, root_path: []const u8) ![][]const u8 {
    var out = std.ArrayList([]const u8).empty;
    const content = io_helper.readFileAlloc(arena, root_path, 4 * 1024 * 1024) catch return out.items;
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena, content, .{}) catch return out.items;
    if (parsed != .object) return out.items;
    const workspaces = parsed.object.get("workspaces") orelse return out.items;
    const list = switch (workspaces) {
        .array => |arr| arr,
        .object => |obj| blk: {
            const pkgs = obj.get("packages") orelse return out.items;
            if (pkgs != .array) return out.items;
            break :blk pkgs.array;
        },
        else => return out.items,
    };
    for (list.items) |item| {
        if (item != .string or item.string.len == 0 or item.string[0] == '!') continue;
        try out.append(arena, item.string);
    }
    return out.items;
}

/// Build the graph: workspace packages at depth 0, the project's direct
/// dependencies at depth 1, then breadth-first through installed manifests.
fn buildGraph(arena: std.mem.Allocator, proj_dir: []const u8, modules_dir: []const u8) !Graph {
    var graph = Graph{
        .arena = arena,
        .modules_root = try std.fs.path.join(arena, &.{ proj_dir, modules_dir }),
    };

    // The project's own manifests: root package.json / pantry.json and every
    // workspace member's package.json.
    var own_manifests = std.ArrayList(Manifest).empty;
    for ([_][]const u8{ "package.json", "pantry.json" }) |file| {
        const path = try std.fs.path.join(arena, &.{ proj_dir, file });
        if (readManifest(arena, path)) |m| try own_manifests.append(arena, m);
    }

    const root_pkg = try std.fs.path.join(arena, &.{ proj_dir, "package.json" });
    const patterns = try workspacePatterns(arena, root_pkg);
    if (patterns.len > 0) {
        const workspace_discovery = @import("../packages/workspace.zig");
        if (workspace_discovery.discoverMembers(arena, proj_dir, patterns)) |members| {
            for (members) |member| {
                const path = try std.fs.path.join(arena, &.{ member.abs_path, "package.json" });
                const m = readManifest(arena, path) orelse continue;
                try own_manifests.append(arena, m);
                const name = m.name orelse continue;
                const n = try graph.node(name);
                n.* = .{ .workspace = true, .own = true, .prod = true, .depth = 0 };
            }
        } else |_| {}
    }

    for (own_manifests.items) |m| {
        for ([_][]const []const u8{ m.prod_deps, m.peer_deps, m.other_deps }, 0..) |names, section| {
            for (names) |name| {
                const n = try graph.node(name);
                n.own = true;
                if (section < 2) n.prod = true;
                n.depth = @min(n.depth, 1);
            }
        }
    }

    // Depth: shortest path over dependencies + optional/dev edges. Seeds are
    // all at depth 0 or 1, so a FIFO visit in insertion order is breadth-first.
    var queue = std.ArrayList([]const u8).empty;
    for (graph.nodes.keys()) |name| if (graph.nodes.get(name).?.depth == 0) try queue.append(arena, name);
    for (graph.nodes.keys()) |name| if (graph.nodes.get(name).?.depth == 1) try queue.append(arena, name);
    var head: usize = 0;
    while (head < queue.items.len) : (head += 1) {
        const name = queue.items[head];
        const depth = graph.nodes.get(name).?.depth;
        const m = graph.manifest(name) orelse continue;
        // A dependency's devDependencies are never installed for it.
        const is_own = graph.nodes.get(name).?.workspace;
        for ([_][]const []const u8{ m.prod_deps, if (is_own) m.other_deps else &.{} }) |names| {
            for (names) |dep| {
                const n = try graph.node(dep);
                if (n.depth > depth + 1) {
                    n.depth = depth + 1;
                    try queue.append(arena, dep);
                }
            }
        }
    }

    // Production reachability: from every node already marked prod, along
    // `dependencies` edges only.
    var prod_queue = std.ArrayList([]const u8).empty;
    for (graph.nodes.keys()) |name| if (graph.nodes.get(name).?.prod) try prod_queue.append(arena, name);
    head = 0;
    while (head < prod_queue.items.len) : (head += 1) {
        const m = graph.manifest(prod_queue.items[head]) orelse continue;
        for (m.prod_deps) |dep| {
            const n = try graph.node(dep);
            if (!n.prod) {
                n.prod = true;
                try prod_queue.append(arena, dep);
            }
        }
    }

    return graph;
}

/// The executable an existing `pantry/.bin` entry runs: a symlink's target,
/// or the quoted path in a script shim (`exec bun "<path>"`, `exec "<path>"`),
/// normalized. A shim inside the tree names its target relative to its own
/// directory (`exec "$d/../pkg/cli.js"`); that is resolved against the shim's
/// directory, the way the shim resolves it at run time.
fn shimTarget(arena: std.mem.Allocator, shim_path: []const u8) ?[]const u8 {
    if (io_helper.readLinkAlloc(arena, shim_path)) |target| {
        const dir = std.fs.path.dirname(shim_path) orelse return target;
        return std.fs.path.resolve(arena, &.{ dir, target }) catch target;
    } else |_| {}

    const content = io_helper.readFileAlloc(arena, shim_path, 64 * 1024) catch return null;
    const exec_at = std.mem.lastIndexOf(u8, content, "exec ") orelse return null;
    const open = std.mem.indexOfScalarPos(u8, content, exec_at, '"') orelse return null;
    const close = std.mem.indexOfScalarPos(u8, content, open + 1, '"') orelse return null;
    const quoted = content[open + 1 .. close];
    if (std.mem.startsWith(u8, quoted, "$d/")) {
        const dir = std.fs.path.dirname(shim_path) orelse return null;
        return std.fs.path.resolve(arena, &.{ dir, quoted["$d/".len..] }) catch null;
    }
    return std.fs.path.resolve(arena, &.{quoted}) catch quoted;
}

fn belongsTo(target: []const u8, modules_root: []const u8, package: []const u8) bool {
    if (!std.mem.startsWith(u8, target, modules_root)) return false;
    const rest = target[modules_root.len..];
    if (rest.len < package.len + 2 or rest[0] != '/') return false;
    return std.mem.startsWith(u8, rest[1..], package) and rest[1 + package.len] == '/';
}

/// Give every bin name that two or more installed npm packages declare to the
/// provider `outranks` selects, rewriting `<proj>/<modules>/.bin/<name>` when
/// it currently runs another contender (or nothing). Prints one warning line
/// per name it had to change. Never fails the install.
pub fn resolveBinCollisions(allocator: std.mem.Allocator, proj_dir: []const u8, modules_dir: []const u8) void {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    resolveBinCollisionsImpl(arena_state.allocator(), proj_dir, modules_dir) catch {};
}

fn resolveBinCollisionsImpl(arena: std.mem.Allocator, proj_dir: []const u8, modules_dir: []const u8) !void {
    var graph = try buildGraph(arena, proj_dir, modules_dir);

    // bin name -> its providers (one per package).
    var claims = std.StringArrayHashMapUnmanaged(std.ArrayList(Provider)).empty;
    for (graph.nodes.keys(), graph.nodes.values()) |name, n| {
        if (n.depth == std.math.maxInt(u32) and !n.prod) continue;
        const m = graph.manifest(name) orelse continue;
        for (m.bins) |bin| {
            const target = try std.fmt.allocPrint(arena, "{s}/{s}/{s}", .{ graph.modules_root, name, bin.rel_path });
            const gop = try claims.getOrPut(arena, bin.name);
            if (!gop.found_existing) gop.value_ptr.* = .empty;
            try gop.value_ptr.append(arena, .{
                .package = name,
                .target = target,
                .workspace = n.workspace,
                .own = n.own,
                .prod = n.prod,
                .depth = n.depth,
            });
        }
    }

    const shim_dir = try std.fs.path.join(arena, &.{ graph.modules_root, ".bin" });

    for (claims.keys(), claims.values()) |bin, all_providers| {
        if (all_providers.items.len < 2) continue;

        // Only providers whose executable is actually installed can own it.
        var providers = std.ArrayList(Provider).empty;
        for (all_providers.items) |p| {
            io_helper.accessAbsolute(p.target, .{}) catch continue;
            try providers.append(arena, p);
        }
        if (providers.items.len == 0) continue;
        const owner = providers.items[pickOwner(providers.items)];

        const shim_path = try std.fs.path.join(arena, &.{ shim_dir, bin });
        if (shimTarget(arena, shim_path)) |current| {
            const wanted = try std.fs.path.resolve(arena, &.{owner.target});
            if (std.mem.eql(u8, current, wanted)) continue;
            var held_by_contender = false;
            for (all_providers.items) |p| {
                if (belongsTo(current, graph.modules_root, p.package)) held_by_contender = true;
            }
            // Something other than these npm packages owns the name: not ours.
            if (!held_by_contender) continue;
        }

        symlink.createShim(arena, bin, owner.target, shim_dir, graph.modules_root) catch continue;

        var others = std.ArrayList(u8).empty;
        for (all_providers.items) |p| {
            if (std.mem.eql(u8, p.package, owner.package)) continue;
            if (others.items.len > 0) try others.appendSlice(arena, ", ");
            try others.appendSlice(arena, p.package);
        }
        style.printWarn("{s}/.bin/{s}: {s} and {s} both provide `{s}`; using {s} ({s})\n", .{
            modules_dir, bin, owner.package, others.items, bin, owner.package, ownerReason(owner),
        });
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "outranks: own packages beat transitive ones" {
    const direct_dev = Provider{ .package = "zzz", .target = "", .own = true, .prod = false, .depth = 1 };
    const transitive_prod = Provider{ .package = "aaa", .target = "", .own = false, .prod = true, .depth = 2 };
    try testing.expect(outranks(direct_dev, transitive_prod));
    try testing.expect(!outranks(transitive_prod, direct_dev));
}

test "outranks: dependencies beat devDependencies at equal standing" {
    // The stacks case: @stacksjs/buddy through `stacks` (dependencies),
    // @buddysh/buddy through `better-dx` (devDependencies), both depth 2.
    const framework = Provider{ .package = "@stacksjs/buddy", .target = "", .prod = true, .depth = 2 };
    const bot = Provider{ .package = "@buddysh/buddy", .target = "", .prod = false, .depth = 2 };
    try testing.expect(outranks(framework, bot));
    try testing.expectEqual(@as(usize, 1), pickOwner(&.{ bot, framework }));
    try testing.expectEqual(@as(usize, 0), pickOwner(&.{ framework, bot }));
}

test "outranks: then shallower depth, then package name" {
    const shallow = Provider{ .package = "zzz", .target = "", .prod = true, .depth = 2 };
    const deep = Provider{ .package = "aaa", .target = "", .prod = true, .depth = 3 };
    try testing.expect(outranks(shallow, deep));

    const a = Provider{ .package = "alpha", .target = "", .prod = true, .depth = 2 };
    const b = Provider{ .package = "beta", .target = "", .prod = true, .depth = 2 };
    try testing.expect(outranks(a, b));
    try testing.expect(!outranks(b, a));
    // Order of discovery never matters.
    try testing.expectEqualStrings("alpha", (&[_]Provider{ b, a })[pickOwner(&.{ b, a })].package);
    try testing.expectEqualStrings("alpha", (&[_]Provider{ a, b })[pickOwner(&.{ a, b })].package);
}

const BinFixture = struct {
    tmp: testing.TmpDir,
    buf: [std.fs.max_path_bytes]u8 = undefined,
    len: usize = 0,

    fn init() !BinFixture {
        var f = BinFixture{ .tmp = testing.tmpDir(.{}) };
        f.len = try f.tmp.dir.realPath(io_helper.io, &f.buf);
        return f;
    }
    fn deinit(self: *BinFixture) void {
        self.tmp.cleanup();
    }
    fn root(self: *BinFixture) []const u8 {
        return self.buf[0..self.len];
    }
    fn write(self: *BinFixture, sub_path: []const u8, data: []const u8) !void {
        if (std.fs.path.dirname(sub_path)) |parent| try self.tmp.dir.createDirPath(io_helper.io, parent);
        try self.tmp.dir.writeFile(io_helper.io, .{ .sub_path = sub_path, .data = data });
    }
    fn abs(self: *BinFixture, sub_path: []const u8) ![]u8 {
        return std.fs.path.join(testing.allocator, &.{ self.root(), sub_path });
    }
    /// Point pantry/.bin/<bin> at `sub_path`, the way createNpmShims would.
    fn shim(self: *BinFixture, bin: []const u8, sub_path: []const u8) !void {
        const target = try self.abs(sub_path);
        defer testing.allocator.free(target);
        const dir = try self.abs("pantry/.bin");
        defer testing.allocator.free(dir);
        const tree = try self.abs("pantry");
        defer testing.allocator.free(tree);
        try symlink.createShim(testing.allocator, bin, target, dir, tree);
    }
    fn expectShim(self: *BinFixture, bin: []const u8, sub_path: []const u8) !void {
        var arena = std.heap.ArenaAllocator.init(testing.allocator);
        defer arena.deinit();
        const shim_path = try std.fmt.allocPrint(arena.allocator(), "{s}/pantry/.bin/{s}", .{ self.root(), bin });
        const want = try std.fs.path.resolve(arena.allocator(), &.{ self.root(), sub_path });
        try testing.expectEqualStrings(want, shimTarget(arena.allocator(), shim_path).?);
    }

    /// A Stacks app: `stacks` (dependencies) brings @stacksjs/buddy, and
    /// `better-dx` (devDependencies) brings @buddysh/buddy; both declare `buddy`.
    fn stacksApp(self: *BinFixture) !void {
        try self.write("package.json",
            \\{"name":"app","dependencies":{"stacks":"^0.75.0"},"devDependencies":{"better-dx":"^0.2.27"}}
        );
        try self.write("pantry/stacks/package.json",
            \\{"name":"stacks","dependencies":{"@stacksjs/buddy":"^0.75.0"}}
        );
        try self.write("pantry/@stacksjs/buddy/package.json",
            \\{"name":"@stacksjs/buddy","bin":{"stacks":"dist/cli.js","buddy":"dist/cli.js","bud":"dist/cli.js"}}
        );
        try self.write("pantry/@stacksjs/buddy/dist/cli.js", "#!/usr/bin/env bun\n");
        try self.write("pantry/better-dx/package.json",
            \\{"name":"better-dx","dependencies":{"@buddysh/buddy":"^0.11.2"}}
        );
        try self.write("pantry/@buddysh/buddy/package.json",
            \\{"name":"@buddysh/buddy","bin":{"buddy":"./dist/bin/cli.js"}}
        );
        try self.write("pantry/@buddysh/buddy/dist/bin/cli.js", "#!/usr/bin/env bun\n");
    }
};

test "resolveBinCollisions gives `buddy` to the dependency, not the devDependency's bot" {
    var f = try BinFixture.init();
    defer f.deinit();
    try f.stacksApp();

    // The bot was shimmed last.
    try f.shim("buddy", "pantry/@buddysh/buddy/./dist/bin/cli.js");
    resolveBinCollisions(testing.allocator, f.root(), "pantry");
    try f.expectShim("buddy", "pantry/@stacksjs/buddy/dist/cli.js");

    // Same answer when the framework CLI was shimmed last: nothing changes.
    try f.shim("buddy", "pantry/@stacksjs/buddy/dist/cli.js");
    resolveBinCollisions(testing.allocator, f.root(), "pantry");
    try f.expectShim("buddy", "pantry/@stacksjs/buddy/dist/cli.js");
}

test "resolveBinCollisions prefers a workspace package over a transitive one" {
    var f = try BinFixture.init();
    defer f.deinit();
    // The framework repo: @stacksjs/buddy is a workspace package linked into
    // pantry/, @buddysh/buddy arrives through the devDependency better-dx.
    try f.write("package.json",
        \\{"name":"stacks","workspaces":["core/*"],"devDependencies":{"better-dx":"^0.2.27"}}
    );
    try f.write("core/buddy/package.json",
        \\{"name":"@stacksjs/buddy","bin":{"buddy":"dist/cli.js"}}
    );
    try f.write("core/buddy/dist/cli.js", "#!/usr/bin/env bun\n");
    try f.tmp.dir.createDirPath(io_helper.io, "pantry/@stacksjs");
    const member = try f.abs("core/buddy");
    defer testing.allocator.free(member);
    const link = try f.abs("pantry/@stacksjs/buddy");
    defer testing.allocator.free(link);
    try io_helper.symLink(member, link);
    try f.write("pantry/better-dx/package.json",
        \\{"name":"better-dx","dependencies":{"@buddysh/buddy":"^0.11.2"}}
    );
    try f.write("pantry/@buddysh/buddy/package.json",
        \\{"name":"@buddysh/buddy","bin":{"buddy":"./dist/bin/cli.js"}}
    );
    try f.write("pantry/@buddysh/buddy/dist/bin/cli.js", "#!/usr/bin/env bun\n");

    try f.shim("buddy", "pantry/@buddysh/buddy/./dist/bin/cli.js");
    resolveBinCollisions(testing.allocator, f.root(), "pantry");
    try f.expectShim("buddy", "pantry/@stacksjs/buddy/dist/cli.js");
}

test "resolveBinCollisions skips a contender whose executable is missing" {
    var f = try BinFixture.init();
    defer f.deinit();
    try f.stacksApp();
    // An unbuilt framework CLI cannot own the name.
    const cli = try f.abs("pantry/@stacksjs/buddy/dist/cli.js");
    defer testing.allocator.free(cli);
    try io_helper.deleteFile(cli);
    try f.shim("buddy", "pantry/@buddysh/buddy/./dist/bin/cli.js");
    resolveBinCollisions(testing.allocator, f.root(), "pantry");
    try f.expectShim("buddy", "pantry/@buddysh/buddy/./dist/bin/cli.js");
}

test "resolveBinCollisions leaves a name owned by a non-contender alone" {
    var f = try BinFixture.init();
    defer f.deinit();
    try f.stacksApp();
    try f.write("pantry/buddy.sh/v1.0.0/bin/buddy", "#!/bin/sh\n");
    const sys = try f.abs("pantry/buddy.sh/v1.0.0/bin/buddy");
    defer testing.allocator.free(sys);
    const link = try f.abs("pantry/.bin/buddy");
    defer testing.allocator.free(link);
    try f.tmp.dir.createDirPath(io_helper.io, "pantry/.bin");
    try io_helper.symLink(sys, link);

    resolveBinCollisions(testing.allocator, f.root(), "pantry");
    try f.expectShim("buddy", "pantry/buddy.sh/v1.0.0/bin/buddy");
}
