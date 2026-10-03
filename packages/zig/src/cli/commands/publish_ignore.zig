//! Ignore-file semantics for publish tarballs (`.pantryignore`, `.npmignore`,
//! `.gitignore`).
//!
//! The patterns used to be handed to `rsync --exclude=` verbatim, which made
//! their meaning depend on whichever rsync the machine had. They are not the
//! same language: on macOS's openrsync `**/node_modules` does not match a
//! top-level `node_modules`, and `bin/watch` matches at every depth, where
//! gitignore anchors any pattern with a slash in the middle (#202).
//!
//! So matching happens here, with gitignore rules, against the real tree.
//! rsync is still the copier, but it only ever sees ANCHORED, LITERAL paths
//! (`/packages/a/node_modules`) — the one pattern form every rsync agrees on.
//!
//! Supported syntax (gitignore):
//!   - blank lines and `#` comments are skipped; `\#` / `\!` escape them
//!   - `!pattern` re-includes (last matching rule wins); like git, a path
//!     inside an excluded directory cannot be re-included
//!   - a trailing `/` matches directories only
//!   - a pattern with no slash (other than a trailing one) matches the name at
//!     any depth; any other slash anchors it to the package root
//!   - `*` and `?` never cross `/`; `[abc]`, `[!a-z]` classes
//!   - `**/x` matches `x` at any depth (including the root), `x/**` everything
//!     inside `x`, and `a/**/b` zero or more directories between them

const std = @import("std");
const io_helper = @import("../../io_helper.zig");

pub const Rule = struct {
    /// Glob, with any leading `/` and trailing `/` removed.
    glob: []const u8,
    negate: bool,
    dir_only: bool,
    /// Matched against the full relative path rather than the basename.
    anchored: bool,
};

/// Parse one ignore-file line. Returns null for blanks and comments. The
/// returned rule borrows `line`.
pub fn parseLine(line: []const u8) ?Rule {
    var s = std.mem.trimEnd(u8, line, "\r");
    // Trailing spaces are insignificant unless escaped (`foo\ `).
    while (s.len > 0 and s[s.len - 1] == ' ' and !(s.len >= 2 and s[s.len - 2] == '\\')) s = s[0 .. s.len - 1];
    s = std.mem.trimStart(u8, s, " \t");
    if (s.len == 0 or s[0] == '#') return null;

    var negate = false;
    if (s[0] == '!') {
        negate = true;
        s = s[1..];
    } else if (s.len >= 2 and s[0] == '\\' and (s[1] == '!' or s[1] == '#')) {
        s = s[1..];
    }

    var dir_only = false;
    while (s.len > 0 and s[s.len - 1] == '/') {
        dir_only = true;
        s = s[0 .. s.len - 1];
    }

    var anchored = std.mem.indexOfScalar(u8, s, '/') != null;
    while (s.len > 0 and s[0] == '/') {
        anchored = true;
        s = s[1..];
    }
    if (s.len == 0) return null;

    return .{ .glob = s, .negate = negate, .dir_only = dir_only, .anchored = anchored };
}

/// Does `rule` match `rel_path` (relative to the package root, `/`-separated,
/// no leading `./`) on its own, without considering parent directories?
pub fn ruleMatches(rule: Rule, rel_path: []const u8, is_dir: bool) bool {
    if (rule.dir_only and !is_dir) return false;
    if (rule.anchored) return wildmatch(rule.glob, rel_path);
    const base = if (std.mem.lastIndexOfScalar(u8, rel_path, '/')) |i| rel_path[i + 1 ..] else rel_path;
    return wildmatch(rule.glob, base);
}

/// gitignore-style glob match of a whole path.
pub fn wildmatch(pattern: []const u8, text: []const u8) bool {
    return matchAt(pattern, 0, text, 0);
}

fn matchAt(p: []const u8, pi_start: usize, t: []const u8, ti_start: usize) bool {
    var pi = pi_start;
    var ti = ti_start;
    while (pi < p.len) {
        const c = p[pi];
        switch (c) {
            '*' => {
                const double = pi + 1 < p.len and p[pi + 1] == '*';
                const at_segment_start = pi == 0 or p[pi - 1] == '/';
                if (double and at_segment_start and (pi + 2 == p.len or p[pi + 2] == '/')) {
                    // `**` as a whole segment.
                    if (pi + 2 == p.len) return true; // trailing `/**`: everything below
                    // `**/rest`: zero or more leading directories.
                    const rest = pi + 3;
                    var k = ti;
                    while (true) {
                        if (matchAt(p, rest, t, k)) return true;
                        const slash = std.mem.indexOfScalarPos(u8, t, k, '/') orelse return false;
                        k = slash + 1;
                    }
                }
                // Plain `*` (a non-segment `**` behaves the same): never crosses `/`.
                var next = pi + 1;
                while (next < p.len and p[next] == '*') next += 1;
                var k = ti;
                while (true) {
                    if (matchAt(p, next, t, k)) return true;
                    if (k >= t.len or t[k] == '/') return false;
                    k += 1;
                }
            },
            '?' => {
                if (ti >= t.len or t[ti] == '/') return false;
                pi += 1;
                ti += 1;
            },
            '[' => {
                if (ti >= t.len or t[ti] == '/') return false;
                const res = matchClass(p, pi, t[ti]) orelse {
                    // Unterminated class: treat `[` literally.
                    if (t[ti] != '[') return false;
                    pi += 1;
                    ti += 1;
                    continue;
                };
                if (!res.matched) return false;
                pi = res.end;
                ti += 1;
            },
            '\\' => {
                const lit = if (pi + 1 < p.len) p[pi + 1] else '\\';
                if (ti >= t.len or t[ti] != lit) return false;
                pi += if (pi + 1 < p.len) 2 else 1;
                ti += 1;
            },
            else => {
                if (ti >= t.len or t[ti] != c) return false;
                pi += 1;
                ti += 1;
            },
        }
    }
    return ti == t.len;
}

const ClassResult = struct { matched: bool, end: usize };

fn matchClass(p: []const u8, open: usize, ch: u8) ?ClassResult {
    var i = open + 1;
    var negate = false;
    if (i < p.len and (p[i] == '!' or p[i] == '^')) {
        negate = true;
        i += 1;
    }
    var matched = false;
    var first = true;
    while (i < p.len) {
        if (p[i] == ']' and !first) return .{ .matched = matched != negate, .end = i + 1 };
        first = false;
        var lo = p[i];
        if (lo == '\\' and i + 1 < p.len) {
            i += 1;
            lo = p[i];
        }
        if (i + 2 < p.len and p[i + 1] == '-' and p[i + 2] != ']') {
            const hi = p[i + 2];
            if (ch >= lo and ch <= hi) matched = true;
            i += 3;
        } else {
            if (ch == lo) matched = true;
            i += 1;
        }
    }
    return null;
}

pub const IgnoreRules = struct {
    allocator: std.mem.Allocator,
    rules: std.ArrayList(Rule) = .empty,
    /// Owned copies of the lines the rules borrow from.
    storage: std.ArrayList([]u8) = .empty,

    pub fn init(allocator: std.mem.Allocator) IgnoreRules {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *IgnoreRules) void {
        for (self.storage.items) |s| self.allocator.free(s);
        self.storage.deinit(self.allocator);
        self.rules.deinit(self.allocator);
    }

    /// Add one ignore-file line. Returns the parsed rule, or null when the
    /// line is a blank or a comment.
    pub fn add(self: *IgnoreRules, line: []const u8) !?Rule {
        const copy = try self.allocator.dupe(u8, line);
        errdefer self.allocator.free(copy);
        const rule = parseLine(copy) orelse {
            self.allocator.free(copy);
            return null;
        };
        try self.storage.append(self.allocator, copy);
        try self.rules.append(self.allocator, rule);
        return rule;
    }

    /// Is this entry itself excluded? The last matching rule decides. Parent
    /// directories are not consulted; `collectExcludes` prunes them instead.
    pub fn isIgnored(self: *const IgnoreRules, rel_path: []const u8, is_dir: bool) bool {
        var ignored = false;
        for (self.rules.items) |rule| {
            if (ruleMatches(rule, rel_path, is_dir)) ignored = !rule.negate;
        }
        return ignored;
    }

    /// Is `rel_path` excluded, either itself or through an excluded parent
    /// directory? This is what a full walk decides for the path.
    pub fn isPathExcluded(self: *const IgnoreRules, rel_path: []const u8, is_dir: bool) bool {
        var i: usize = 0;
        while (std.mem.indexOfScalarPos(u8, rel_path, i, '/')) |slash| : (i = slash + 1) {
            if (self.isIgnored(rel_path[0..slash], true)) return true;
        }
        return self.isIgnored(rel_path, is_dir);
    }

    /// Walk `root` and return an rsync exclude list (one pattern per line):
    /// every excluded entry as an anchored literal path. Excluded directories
    /// are listed once and not descended into; symlinks are never followed.
    pub fn collectExcludes(self: *const IgnoreRules, allocator: std.mem.Allocator, root: []const u8) ![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(allocator);
        var rel: std.ArrayList(u8) = .empty;
        defer rel.deinit(allocator);
        try self.walk(allocator, root, &rel, &out);
        return out.toOwnedSlice(allocator);
    }

    fn walk(
        self: *const IgnoreRules,
        allocator: std.mem.Allocator,
        root: []const u8,
        rel: *std.ArrayList(u8),
        out: *std.ArrayList(u8),
    ) !void {
        const dir_path = if (rel.items.len == 0)
            try allocator.dupe(u8, root)
        else
            try std.fs.path.join(allocator, &.{ root, rel.items });
        defer allocator.free(dir_path);

        var dir = io_helper.openDirForIteration(dir_path) catch return;
        defer dir.close();
        var iter = dir.iterate();
        while (iter.next() catch null) |entry| {
            if (std.mem.eql(u8, entry.name, ".") or std.mem.eql(u8, entry.name, "..")) continue;
            // A name rsync cannot be told about on one line; leave it to rsync.
            if (std.mem.indexOfScalar(u8, entry.name, '\n') != null) continue;

            const saved = rel.items.len;
            defer rel.shrinkRetainingCapacity(saved);
            if (saved > 0) try rel.append(allocator, '/');
            try rel.appendSlice(allocator, entry.name);

            const is_dir = switch (entry.kind) {
                .directory => true,
                .unknown => blk: {
                    const full = try std.fs.path.join(allocator, &.{ root, rel.items });
                    defer allocator.free(full);
                    var probe = io_helper.openDirForIteration(full) catch break :blk false;
                    probe.close();
                    break :blk true;
                },
                else => false,
            };

            if (self.isIgnored(rel.items, is_dir)) {
                try appendAnchoredLiteral(allocator, out, rel.items);
                continue;
            }
            if (is_dir) try self.walk(allocator, root, rel, out);
        }
    }
};

/// Walk `package_dir` and write the rsync `--exclude-from` list for it to
/// `list_path`. Returns how many entries it excludes.
pub fn writeExcludeFile(
    allocator: std.mem.Allocator,
    rules: *const IgnoreRules,
    package_dir: []const u8,
    list_path: []const u8,
) !usize {
    const list = try rules.collectExcludes(allocator, package_dir);
    defer allocator.free(list);
    const file = try io_helper.createFileAbsolute(list_path, .{});
    defer io_helper.closeFile(file);
    try io_helper.writeAllToFile(file, list);
    return std.mem.count(u8, list, "\n");
}

/// Append `/<rel>` as an rsync pattern that matches exactly that path. rsync
/// only interprets `\` as an escape in patterns containing a wildcard, so a
/// name is escaped only when it has one.
fn appendAnchoredLiteral(allocator: std.mem.Allocator, out: *std.ArrayList(u8), rel: []const u8) !void {
    try out.append(allocator, '/');
    const has_wild = std.mem.indexOfAny(u8, rel, "*?[") != null;
    for (rel) |c| {
        if (has_wild and (c == '*' or c == '?' or c == '[' or c == '\\')) try out.append(allocator, '\\');
        try out.append(allocator, c);
    }
    try out.append(allocator, '\n');
}

// ============================================================================
// Tests
// ============================================================================

const testing = std.testing;

fn rulesFrom(allocator: std.mem.Allocator, lines: []const []const u8) !IgnoreRules {
    var rules = IgnoreRules.init(allocator);
    errdefer rules.deinit();
    for (lines) |l| _ = try rules.add(l);
    return rules;
}

test "**/node_modules excludes node_modules at the root and at any depth (#202)" {
    var rules = try rulesFrom(testing.allocator, &.{"**/node_modules"});
    defer rules.deinit();
    try testing.expect(rules.isIgnored("node_modules", true));
    try testing.expect(rules.isIgnored("packages/a/node_modules", true));
    try testing.expect(rules.isIgnored("a/b/c/d/node_modules", true));
    try testing.expect(rules.isPathExcluded("packages/a/node_modules/x/index.js", false));
    try testing.expect(!rules.isIgnored("packages/a/node_modules_backup", true));
    try testing.expect(!rules.isIgnored("my_node_modules", true));
}

test "a bare name matches at any depth" {
    var rules = try rulesFrom(testing.allocator, &.{ "node_modules", "*.log" });
    defer rules.deinit();
    try testing.expect(rules.isIgnored("node_modules", true));
    try testing.expect(rules.isIgnored("packages/a/node_modules", true));
    try testing.expect(rules.isIgnored("debug.log", false));
    try testing.expect(rules.isIgnored("logs/deep/x.log", false));
    try testing.expect(!rules.isIgnored("log.txt", false));
}

test "a trailing slash matches directories only, at any depth" {
    var rules = try rulesFrom(testing.allocator, &.{ "build/", "node_modules/" });
    defer rules.deinit();
    try testing.expect(rules.isIgnored("build", true));
    try testing.expect(rules.isIgnored("packages/p/build", true));
    try testing.expect(!rules.isIgnored("build", false)); // a FILE named build stays
    try testing.expect(rules.isIgnored("packages/p/node_modules", true));
}

test "a slash in the middle anchors the pattern to the package root" {
    var rules = try rulesFrom(testing.allocator, &.{ "packages/ts-watches/test", "/docs", "bin/watch" });
    defer rules.deinit();
    try testing.expect(rules.isIgnored("packages/ts-watches/test", true));
    try testing.expect(!rules.isIgnored("x/packages/ts-watches/test", true));
    try testing.expect(rules.isIgnored("docs", true));
    try testing.expect(!rules.isIgnored("packages/a/docs", true));
    try testing.expect(rules.isIgnored("bin/watch", false));
    try testing.expect(!rules.isIgnored("packages/a/bin/watch", false));
}

test "** segments: leading, trailing and in the middle" {
    var rules = try rulesFrom(testing.allocator, &.{ "**/bin/watch-*", "docs/.vitepress/**", "a/**/z" });
    defer rules.deinit();
    try testing.expect(rules.isIgnored("bin/watch-linux", false));
    try testing.expect(rules.isIgnored("packages/x/bin/watch-darwin", false));
    try testing.expect(!rules.isIgnored("packages/x/bin/watch", false));
    try testing.expect(rules.isIgnored("docs/.vitepress/cache", true));
    try testing.expect(!rules.isIgnored("docs/.vitepress", true));
    try testing.expect(rules.isIgnored("a/z", false));
    try testing.expect(rules.isIgnored("a/b/c/z", false));
    try testing.expect(!rules.isIgnored("ab/z", false));
}

test "* and ? never cross a slash; classes and escapes" {
    try testing.expect(wildmatch("src/*.ts", "src/a.ts"));
    try testing.expect(!wildmatch("src/*.ts", "src/x/a.ts"));
    try testing.expect(wildmatch("file?.txt", "file1.txt"));
    try testing.expect(!wildmatch("a?b", "a/b"));
    try testing.expect(wildmatch("[abc].md", "b.md"));
    try testing.expect(!wildmatch("[!abc].md", "b.md"));
    try testing.expect(wildmatch("v[0-9]", "v7"));
    try testing.expect(wildmatch("\\*literal", "*literal"));
    try testing.expect(!wildmatch("\\*literal", "xliteral"));
}

test "negation re-includes, last matching rule wins; comments and blanks skipped" {
    var rules = try rulesFrom(testing.allocator, &.{ "# comment", "", "*.md", "!README.md", "   " });
    defer rules.deinit();
    try testing.expectEqual(@as(usize, 2), rules.rules.items.len);
    try testing.expect(rules.isIgnored("NOTES.md", false));
    try testing.expect(!rules.isIgnored("README.md", false));
}

test "collectExcludes lists anchored literal paths and prunes excluded directories" {
    const allocator = testing.allocator;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];

    const files = [_][]const u8{
        "node_modules/a/index.js",
        "packages/p/node_modules/b/index.js",
        "packages/p/dist/index.js",
        "packages/p/build/out.js",
        "keep/build",
        "debug.log",
        "src/index.ts",
    };
    for (files) |f| {
        const full = try std.fs.path.join(allocator, &.{ root, f });
        defer allocator.free(full);
        try io_helper.makePath(std.fs.path.dirname(full).?);
        const file = try io_helper.createFileAbsolute(full, .{});
        io_helper.closeFile(file);
    }

    var rules = try rulesFrom(allocator, &.{ "**/node_modules", "build/", "*.log" });
    defer rules.deinit();
    const list = try rules.collectExcludes(allocator, root);
    defer allocator.free(list);

    var lines: std.ArrayList([]const u8) = .empty;
    defer lines.deinit(allocator);
    var it = std.mem.tokenizeScalar(u8, list, '\n');
    while (it.next()) |l| try lines.append(allocator, l);
    std.mem.sort([]const u8, lines.items, {}, struct {
        fn lt(_: void, a: []const u8, b: []const u8) bool {
            return std.mem.lessThan(u8, a, b);
        }
    }.lt);

    const expected = [_][]const u8{ "/debug.log", "/node_modules", "/packages/p/build", "/packages/p/node_modules" };
    try testing.expectEqual(expected.len, lines.items.len);
    for (expected, lines.items) |e, got| try testing.expectEqualStrings(e, got);
}

test "anchored literals escape wildcard characters only when present" {
    const allocator = testing.allocator;
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(allocator);
    try appendAnchoredLiteral(allocator, &out, "a/plain");
    try appendAnchoredLiteral(allocator, &out, "a/[x]*\\y");
    try testing.expectEqualStrings("/a/plain\n/a/\\[x]\\*\\\\y\n", out.items);
}

test "rsync honours the generated list: nested node_modules never reach the staging tree (#202)" {
    const allocator = testing.allocator;
    const rsync = (try io_helper.findExecutable(allocator, "rsync")) orelse return error.SkipZigTest;
    allocator.free(rsync);

    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const base = root_buf[0..try tmp.dir.realPath(io_helper.io, &root_buf)];

    const src = try std.fs.path.join(allocator, &.{ base, "src" });
    defer allocator.free(src);
    const dst = try std.fs.path.join(allocator, &.{ base, "dst" });
    defer allocator.free(dst);
    const list_path = try std.fs.path.join(allocator, &.{ base, "excludes" });
    defer allocator.free(list_path);

    const files = [_][]const u8{
        "node_modules/a/index.js",
        "packages/p/node_modules/b/index.js",
        "packages/p/dist/index.js",
        "packages/p/bin/watch",
        "bin/watch",
        "docs/.vitepress/cache/x",
        "README.md",
    };
    for (files) |f| {
        const full = try std.fs.path.join(allocator, &.{ src, f });
        defer allocator.free(full);
        try io_helper.makePath(std.fs.path.dirname(full).?);
        io_helper.closeFile(try io_helper.createFileAbsolute(full, .{}));
    }

    // The ts-watches .pantryignore shapes that motivated #202.
    var rules = try rulesFrom(allocator, &.{ "**/node_modules", "**/bin/watch", "docs/.vitepress/cache" });
    defer rules.deinit();
    _ = try writeExcludeFile(allocator, &rules, src, list_path);

    const src_arg = try std.fmt.allocPrint(allocator, "{s}/", .{src});
    defer allocator.free(src_arg);
    const dst_arg = try std.fmt.allocPrint(allocator, "{s}/", .{dst});
    defer allocator.free(dst_arg);
    const from_arg = try std.fmt.allocPrint(allocator, "--exclude-from={s}", .{list_path});
    defer allocator.free(from_arg);
    const res = try io_helper.childRun(allocator, &.{ "rsync", "-a", from_arg, src_arg, dst_arg });
    allocator.free(res.stdout);
    allocator.free(res.stderr);
    try testing.expect(res.term == .exited and res.term.exited == 0);

    const kept = [_][]const u8{ "packages/p/dist/index.js", "README.md", "docs/.vitepress" };
    const gone = [_][]const u8{ "node_modules", "packages/p/node_modules", "bin/watch", "packages/p/bin/watch", "docs/.vitepress/cache" };
    for (kept) |k| {
        const full = try std.fs.path.join(allocator, &.{ dst, k });
        defer allocator.free(full);
        io_helper.accessAbsolute(full, .{}) catch |err| {
            std.debug.print("expected {s} to be staged: {any}\n", .{ k, err });
            return err;
        };
    }
    for (gone) |g| {
        const full = try std.fs.path.join(allocator, &.{ dst, g });
        defer allocator.free(full);
        if (io_helper.accessAbsolute(full, .{})) |_| {
            std.debug.print("expected {s} to be excluded\n", .{g});
            return error.TestUnexpectedResult;
        } else |_| {}
    }
}
