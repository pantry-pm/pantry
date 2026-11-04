//! Release Command — bump version, generate changelog, commit, tag, push.
//!
//! Wraps the `bump` CLI (from zig-bump) and `changelog` CLI (from zig-changelog)
//! into a single `pantry release <type>` command.
//!
//! Flow:
//!   1. Generate changelog via `changelog` (if available)
//!   2. Bump version via `bump <type>` (commits, tags, pushes)
//!   → GitHub Action triggers → creates release → publishes to registry

const std = @import("std");
const io_helper = @import("../../io_helper.zig");
const style = @import("../style.zig");

pub const CommandResult = @import("common.zig").CommandResult;

pub const ReleaseOptions = struct {
    /// Release type: patch, minor, major, premajor, preminor, prepatch, prerelease, or exact version
    release_type: []const u8 = "patch",
    /// Prerelease identifier (alpha, beta, rc)
    preid: ?[]const u8 = null,
    /// Skip confirmation prompts
    yes: bool = false,
    /// Dry run — show what would happen without applying
    dry_run: bool = false,
    /// Skip changelog generation
    no_changelog: bool = false,
    /// Skip git push
    no_push: bool = false,
    /// Release even when CI looks unable to publish the result. The preflight
    /// cannot see environment secrets, and a release does not have to publish
    /// at all, so its verdict has to be overridable.
    skip_token_check: bool = false,
    /// Custom tag name pattern (default: v{version})
    tag_name: ?[]const u8 = null,
};

/// Find a binary in PATH or pantry's bin directories.
/// Caller owns the returned slice and must free it with `allocator`.
fn findBinary(allocator: std.mem.Allocator, name: []const u8) ?[]const u8 {
    // Check pantry bin dirs first
    const home = io_helper.getenv("HOME") orelse return null;
    const pantry_bin_paths = [_][]const u8{
        "pantry/.bin",
        ".pantry/bin",
    };

    for (pantry_bin_paths) |rel| {
        const full = std.fmt.allocPrint(allocator, "{s}/{s}/{s}", .{ home, rel, name }) catch continue;
        io_helper.accessAbsolute(full, .{}) catch {
            allocator.free(full);
            continue;
        };
        return full;
    }

    // Check CWD pantry/.bin
    const cwd_bin = std.fmt.allocPrint(allocator, "pantry/.bin/{s}", .{name}) catch return null;
    io_helper.accessAbsolute(cwd_bin, .{}) catch {
        allocator.free(cwd_bin);
        // Fall back to PATH lookup via `which`
        return findBinaryInPath(allocator, name);
    };
    return cwd_bin;
}

/// Look up a binary on PATH. Delegates to io_helper.findExecutable, which walks
/// $PATH using libc access(X_OK) — robust across shells (the previous `which`
/// subprocess approach failed because `which` is a shell builtin in some
/// environments, so `bump` couldn't be located even when it was on PATH).
fn findBinaryInPath(allocator: std.mem.Allocator, name: []const u8) ?[]const u8 {
    return (io_helper.findExecutable(allocator, name) catch return null) orelse null;
}

/// Run a git command, returning trimmed stdout (caller owns). Returns null on failure.
fn gitCapture(allocator: std.mem.Allocator, args: []const []const u8) ?[]const u8 {
    const result = io_helper.childRun(allocator, args) catch return null;
    defer allocator.free(result.stderr);
    if (!(result.term == .exited and result.term.exited == 0)) {
        allocator.free(result.stdout);
        return null;
    }
    var end = result.stdout.len;
    while (end > 0 and (result.stdout[end - 1] == '\n' or result.stdout[end - 1] == '\r' or result.stdout[end - 1] == ' ')) {
        end -= 1;
    }
    const out = allocator.dupe(u8, result.stdout[0..end]) catch {
        allocator.free(result.stdout);
        return null;
    };
    allocator.free(result.stdout);
    return out;
}

const SemVer = struct {
    major: u64 = 0,
    minor: u64 = 0,
    patch: u64 = 0,

    /// Parse a semver core (major.minor.patch), ignoring any leading 'v' and
    /// any prerelease/build suffix after the patch number. Returns null if it
    /// doesn't look like a version at all.
    fn parse(s: []const u8) ?SemVer {
        var str = s;
        if (str.len > 0 and (str[0] == 'v' or str[0] == 'V')) str = str[1..];
        var parts: [3]u64 = .{ 0, 0, 0 };
        var idx: usize = 0;
        var num_start: usize = 0;
        var i: usize = 0;
        var saw_digit = false;
        while (i <= str.len) : (i += 1) {
            const at_end = i == str.len;
            const c = if (at_end) '.' else str[i];
            if (c == '.' or c == '-' or c == '+') {
                if (idx < 3) {
                    const seg = str[num_start..i];
                    if (seg.len == 0) return null;
                    parts[idx] = std.fmt.parseInt(u64, seg, 10) catch return null;
                    idx += 1;
                }
                if (c == '-' or c == '+') break;
                num_start = i + 1;
            } else if (c >= '0' and c <= '9') {
                saw_digit = true;
            } else {
                return null;
            }
        }
        if (!saw_digit) return null;
        return .{ .major = parts[0], .minor = parts[1], .patch = parts[2] };
    }

    /// Returns true if `self` is strictly greater than `other`.
    fn greaterThan(self: SemVer, other: SemVer) bool {
        if (self.major != other.major) return self.major > other.major;
        if (self.minor != other.minor) return self.minor > other.minor;
        return self.patch > other.patch;
    }
};

/// Read the `.version = "x.y.z"` value from build.zig.zon in CWD.
/// Caller owns the returned slice.
fn readZonVersion(allocator: std.mem.Allocator) ?[]const u8 {
    const content = io_helper.readFileAlloc(allocator, "build.zig.zon", 1 << 20) catch return null;
    defer allocator.free(content);
    const key = ".version";
    const key_pos = std.mem.indexOf(u8, content, key) orelse return null;
    var i = key_pos + key.len;
    // skip to opening quote
    while (i < content.len and content[i] != '"') : (i += 1) {
        if (content[i] == '\n') return null;
    }
    if (i >= content.len) return null;
    i += 1; // past opening quote
    const start = i;
    while (i < content.len and content[i] != '"') : (i += 1) {}
    if (i >= content.len) return null;
    return allocator.dupe(u8, content[start..i]) catch return null;
}

/// Rewrite the `.version = "..."` value in build.zig.zon in CWD to `new_version`.
/// Returns true on success. Used to sync the zon up to the latest tag before a
/// bump (zig-bump only accepts patch/minor/major, not an explicit version, so we
/// must do the sync ourselves).
fn writeZonVersion(allocator: std.mem.Allocator, new_version: []const u8) bool {
    const content = io_helper.readFileAlloc(allocator, "build.zig.zon", 1 << 20) catch return false;
    defer allocator.free(content);
    const key = ".version";
    const key_pos = std.mem.indexOf(u8, content, key) orelse return false;
    var i = key_pos + key.len;
    while (i < content.len and content[i] != '"') : (i += 1) {
        if (content[i] == '\n') return false;
    }
    if (i >= content.len) return false;
    const val_start = i + 1; // first char inside quotes
    var j = val_start;
    while (j < content.len and content[j] != '"') : (j += 1) {}
    if (j >= content.len) return false;

    const out = std.fmt.allocPrint(allocator, "{s}{s}{s}", .{
        content[0..val_start], new_version, content[j..],
    }) catch return false;
    defer allocator.free(out);

    const file = io_helper.createFile("build.zig.zon", .{}) catch return false;
    defer io_helper.closeFile(file);
    io_helper.writeAllToFile(file, out) catch return false;
    return true;
}

/// Find the highest git tag that parses as a semver (vX.Y.Z). Returns the
/// parsed SemVer, or null if there are no version tags.
fn latestTagVersion(allocator: std.mem.Allocator) ?SemVer {
    const out = gitCapture(allocator, &.{ "git", "tag", "--list", "v*" }) orelse return null;
    defer allocator.free(out);
    var best: ?SemVer = null;
    var it = std.mem.splitScalar(u8, out, '\n');
    while (it.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len == 0) continue;
        const v = SemVer.parse(trimmed) orelse continue;
        if (best == null or v.greaterThan(best.?)) best = v;
    }
    return best;
}

/// Reconcile build.zig.zon version with the latest git tag. zig-bump increments
/// from the zon version and ignores git tags entirely, so if the zon version has
/// drifted *behind* the latest published tag, a `patch` bump would produce a
/// version that's already tagged (a clash) or non-monotonic. To keep releases
/// monotonic across every repo, we sync the zon up to the latest tag's version
/// before bumping, so the increment always lands above the highest existing tag.
fn reconcileVersionDrift(allocator: std.mem.Allocator) void {
    const zon_str = readZonVersion(allocator) orelse return;
    defer allocator.free(zon_str);
    const zon_ver = SemVer.parse(zon_str) orelse return;
    const tag_ver = latestTagVersion(allocator) orelse return;

    if (!tag_ver.greaterThan(zon_ver)) return; // zon is at or ahead of tags — nothing to do

    const synced = std.fmt.allocPrint(allocator, "{d}.{d}.{d}", .{ tag_ver.major, tag_ver.minor, tag_ver.patch }) catch return;
    defer allocator.free(synced);

    style.print(
        "{s}>{s} build.zig.zon version ({s}{s}{s}) is behind latest tag ({s}v{s}{s}); syncing zon to {s}v{s}{s} before bump\n",
        .{
            style.dim,    style.reset, style.yellow, zon_str,          style.reset,
            style.yellow, synced,      style.reset,  style.green_bold, synced,
            style.reset,
        },
    );

    // zig-bump only accepts patch/minor/major (not an explicit version), and it
    // ignores git tags — so we rewrite the zon ourselves to the latest tag. The
    // subsequent `bump <type>` then increments from there, landing above every
    // existing tag. (Not committed here; the bump commit picks it up.)
    if (!writeZonVersion(allocator, synced)) {
        style.print("  {s}(could not rewrite build.zig.zon — proceeding with bump from {s}){s}\n", .{ style.yellow, zon_str, style.reset });
    }
}

/// Verify the working tree is clean so `bump` only commits the version/changelog
/// changes it makes — not unrelated staged or modified files. Returns true if clean.
fn workingTreeClean(allocator: std.mem.Allocator) bool {
    const out = gitCapture(allocator, &.{ "git", "status", "--porcelain" }) orelse return true;
    defer allocator.free(out);
    // We only care about *tracked* changes that `bump` might accidentally sweep
    // into the release commit. Untracked files ("??") are left alone by bump
    // (it stages only build.zig.zon and CHANGELOG.md), and crucially the set of
    // untracked files varies by environment — e.g. a global ~/.config/git/ignore
    // that a spawned git may not pick up — so untracked entries must never block
    // a release. CHANGELOG.md is regenerated by release, so allow it too.
    var it = std.mem.splitScalar(u8, out, '\n');
    while (it.next()) |line| {
        if (line.len < 3) continue; // porcelain lines are "XY <path>"
        const status = line[0..2];
        if (std.mem.eql(u8, status, "??")) continue; // untracked — irrelevant
        const path = std.mem.trim(u8, line[3..], " \t\r");
        if (std.mem.endsWith(u8, path, "CHANGELOG.md")) continue;
        return false;
    }
    return true;
}

/// Compute the next version from `current` and the release `type`. Caller owns
/// the returned slice.
fn computeNewVersion(allocator: std.mem.Allocator, current: SemVer, release_type: []const u8, preid: ?[]const u8) ?[]const u8 {
    const id = preid orelse "alpha";
    if (std.mem.eql(u8, release_type, "patch")) {
        return std.fmt.allocPrint(allocator, "{d}.{d}.{d}", .{ current.major, current.minor, current.patch + 1 }) catch null;
    } else if (std.mem.eql(u8, release_type, "minor")) {
        return std.fmt.allocPrint(allocator, "{d}.{d}.0", .{ current.major, current.minor + 1 }) catch null;
    } else if (std.mem.eql(u8, release_type, "major")) {
        return std.fmt.allocPrint(allocator, "{d}.0.0", .{current.major + 1}) catch null;
    } else if (std.mem.eql(u8, release_type, "premajor")) {
        return std.fmt.allocPrint(allocator, "{d}.0.0-{s}.0", .{ current.major + 1, id }) catch null;
    } else if (std.mem.eql(u8, release_type, "preminor")) {
        return std.fmt.allocPrint(allocator, "{d}.{d}.0-{s}.0", .{ current.major, current.minor + 1, id }) catch null;
    } else if (std.mem.eql(u8, release_type, "prepatch")) {
        return std.fmt.allocPrint(allocator, "{d}.{d}.{d}-{s}.0", .{ current.major, current.minor, current.patch + 1, id }) catch null;
    }
    // Treat anything else as an explicit version string (strip a leading 'v').
    const v = if (release_type.len > 0 and (release_type[0] == 'v' or release_type[0] == 'V')) release_type[1..] else release_type;
    if (SemVer.parse(v) == null) return null;
    return allocator.dupe(u8, v) catch null;
}

/// Rewrite the `"version": "..."` value in package.json if present.
fn writePackageJsonVersion(allocator: std.mem.Allocator, new_version: []const u8) void {
    const content = io_helper.readFileAlloc(allocator, "package.json", 1 << 20) catch return;
    defer allocator.free(content);
    const key = "\"version\"";
    const key_pos = std.mem.indexOf(u8, content, key) orelse return;
    var i = key_pos + key.len;
    while (i < content.len and content[i] != '"') : (i += 1) {
        if (content[i] == '{') return;
    }
    if (i >= content.len) return;
    const val_start = i + 1;
    var j = val_start;
    while (j < content.len and content[j] != '"') : (j += 1) {}
    if (j >= content.len) return;
    const out = std.fmt.allocPrint(allocator, "{s}{s}{s}", .{ content[0..val_start], new_version, content[j..] }) catch return;
    defer allocator.free(out);
    const file = io_helper.createFile("package.json", .{}) catch return;
    defer io_helper.closeFile(file);
    io_helper.writeAllToFile(file, out) catch return;
}

fn gitRun(allocator: std.mem.Allocator, args: []const []const u8) bool {
    const result = io_helper.childRun(allocator, args) catch return false;
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    if (!(result.term == .exited and result.term.exited == 0)) {
        if (result.stderr.len > 0) style.print("{s}", .{result.stderr});
        return false;
    }
    return true;
}

/// Regenerate CHANGELOG.md with a new section for `new_version` built from the
/// git commit subjects since the previous tag. Self-contained — no external
/// changelog binary required.
fn generateChangelog(allocator: std.mem.Allocator, new_version: []const u8) void {
    const prev = latestTagVersion(allocator);
    const range: ?[]const u8 = if (prev) |p| std.fmt.allocPrint(allocator, "v{d}.{d}.{d}..HEAD", .{ p.major, p.minor, p.patch }) catch null else null;
    defer if (range) |r| allocator.free(r);

    const log = if (range) |r|
        gitCapture(allocator, &.{ "git", "log", r, "--no-merges", "--pretty=format:- %s (%h)" })
    else
        gitCapture(allocator, &.{ "git", "log", "--no-merges", "--pretty=format:- %s (%h)" });
    defer if (log) |l| allocator.free(l);

    const date = gitCapture(allocator, &.{ "git", "log", "-1", "--pretty=format:%cs" }) orelse allocator.dupe(u8, "") catch return;
    defer allocator.free(date);

    const body = if (log) |l| (if (l.len > 0) l else "- No notable changes") else "- No notable changes";

    const existing = io_helper.readFileAlloc(allocator, "CHANGELOG.md", 1 << 22) catch allocator.dupe(u8, "") catch return;
    defer allocator.free(existing);
    const tail = if (std.mem.startsWith(u8, existing, "# Changelog")) blk: {
        const nl = std.mem.indexOfScalar(u8, existing, '\n') orelse existing.len;
        break :blk existing[nl..];
    } else existing;

    var tail_trimmed = tail;
    while (tail_trimmed.len > 0 and tail_trimmed[0] == '\n') tail_trimmed = tail_trimmed[1..];

    const out = std.fmt.allocPrint(allocator,
        \\# Changelog
        \\
        \\## v{s} - {s}
        \\
        \\{s}
        \\
        \\{s}
    , .{ new_version, date, body, tail_trimmed }) catch return;
    defer allocator.free(out);

    const file = io_helper.createFile("CHANGELOG.md", .{}) catch return;
    defer io_helper.closeFile(file);
    io_helper.writeAllToFile(file, out) catch return;
    style.print("  {s}CHANGELOG.md updated{s}\n", .{ style.green, style.reset });
}

// ============================================================================
// CI publish-credential preflight
// ============================================================================

/// `owner/name` from a GitHub remote URL, or null when it isn't one.
///
/// Every form `git remote` hands back names the host the same way, so this
/// finds the host and takes what follows: https://github.com/owner/name(.git),
/// ssh://git@github.com/owner/name(.git), git@github.com:owner/name(.git).
fn parseRepoSlug(url: []const u8) ?[]const u8 {
    const host = "github.com";
    const at = std.mem.indexOf(u8, url, host) orelse return null;
    var rest = url[at + host.len ..];
    if (rest.len < 2 or (rest[0] != '/' and rest[0] != ':')) return null;
    rest = std.mem.trimEnd(u8, rest[1..], "/");
    if (std.mem.endsWith(u8, rest, ".git")) rest = rest[0 .. rest.len - ".git".len];

    // Exactly one slash separates owner from name; anything else is a URL this
    // has misread, and guessing at it would address the wrong repository.
    const slash = std.mem.indexOfScalar(u8, rest, '/') orelse return null;
    if (slash == 0 or slash + 1 >= rest.len) return null;
    if (std.mem.indexOfScalarPos(u8, rest, slash + 1, '/') != null) return null;
    return rest;
}

/// `owner/name` for the `origin` remote. Caller owns the result.
fn originRepoSlug(allocator: std.mem.Allocator) ?[]const u8 {
    const url = gitCapture(allocator, &.{ "git", "remote", "get-url", "origin" }) orelse return null;
    defer allocator.free(url);
    const slug = parseRepoSlug(url) orelse return null;
    return allocator.dupe(u8, slug) catch null;
}

fn containsName(list: []const []const u8, name: []const u8) bool {
    for (list) |item| {
        if (std.mem.eql(u8, item, name)) return true;
    }
    return false;
}

/// Collect `secrets.NAME` references from `content` that look like a pantry
/// credential, appending the new ones to `names`.
///
/// Matching on PANTRY rather than on one fixed name is deliberate: a
/// repository calls the secret whatever it likes — PANTRY_TOKEN,
/// PANTRY_REGISTRY_TOKEN, HQ_PANTRY_TOKEN — and the workflow reading it is the
/// only authority on which name this repository chose.
fn collectPantrySecretRefs(
    arena: std.mem.Allocator,
    content: []const u8,
    names: *std.ArrayList([]const u8),
) !void {
    const marker = "secrets.";
    var pos: usize = 0;
    while (std.mem.indexOfPos(u8, content, pos, marker)) |at| {
        var end = at + marker.len;
        while (end < content.len and (std.ascii.isAlphanumeric(content[end]) or content[end] == '_')) end += 1;
        const name = content[at + marker.len .. end];
        pos = if (end > pos) end else pos + 1;
        if (name.len == 0) continue;
        if (std.mem.indexOf(u8, name, "PANTRY") == null) continue;
        if (containsName(names.items, name)) continue;
        try names.append(arena, try arena.dupe(u8, name));
    }
}

/// Pantry secrets every workflow in this repository reads.
fn workflowPantrySecrets(arena: std.mem.Allocator) std.ArrayList([]const u8) {
    var names = std.ArrayList([]const u8).empty;

    const workflows_dir = ".github/workflows";
    var dir = io_helper.openDirForIteration(workflows_dir) catch return names;
    defer dir.close();

    var iter = dir.iterate();
    while (iter.next() catch null) |entry| {
        if (entry.kind != .file and entry.kind != .sym_link) continue;
        if (!std.mem.endsWith(u8, entry.name, ".yml") and !std.mem.endsWith(u8, entry.name, ".yaml")) continue;

        const path = std.fs.path.join(arena, &.{ workflows_dir, entry.name }) catch continue;
        const content = io_helper.readFileAlloc(arena, path, 4 << 20) catch continue;
        collectPantrySecretRefs(arena, content, &names) catch continue;
    }
    return names;
}

/// Secret names GitHub would expose to a workflow run in `slug`: the
/// repository's own, plus the organization secrets shared with it.
///
/// Null means the question could not be asked — no `gh`, not signed in, no
/// network — which is emphatically not the same answer as "none", and must
/// never be reported as one.
fn configuredSecretNames(arena: std.mem.Allocator, slug: []const u8) ?std.ArrayList([]const u8) {
    const gh = (io_helper.findExecutable(arena, "gh") catch null) orelse return null;

    var names = std.ArrayList([]const u8).empty;
    var answered = false;

    // Repository secrets first. Organization secrets are a separate endpoint
    // that 404s on a repository outside an org, so its failure is ordinary and
    // only the repository endpoint decides whether we got an answer at all.
    const endpoints = [_][]const u8{ "actions/secrets", "actions/organization-secrets" };
    for (endpoints, 0..) |endpoint, index| {
        const path = std.fmt.allocPrint(arena, "repos/{s}/{s}", .{ slug, endpoint }) catch return null;
        const out = gitCapture(arena, &.{ gh, "api", "--paginate", path, "--jq", ".secrets[].name" });
        if (out) |text| {
            if (index == 0) answered = true;
            var lines = std.mem.splitScalar(u8, text, '\n');
            while (lines.next()) |line| {
                const name = std.mem.trim(u8, line, " \t\r");
                if (name.len == 0) continue;
                if (containsName(names.items, name)) continue;
                names.append(arena, arena.dupe(u8, name) catch continue) catch continue;
            }
        }
    }

    if (!answered) return null;
    return names;
}

const CredentialPreflight = enum {
    /// Either the workflows need no pantry credential, or every name they read
    /// is configured.
    ok,
    /// The question could not be answered, which is not a reason to refuse.
    undetermined,
    /// A workflow reads a secret this repository demonstrably does not have.
    missing,
};

/// Check, before anything is written, that CI will be able to publish what
/// this release produces.
///
/// `pantry release` finishes by pushing a tag and announcing that the GitHub
/// Action will publish to the registry — without ever checking that the Action
/// can authenticate. When it cannot, the failure surfaces minutes later inside
/// a workflow log, as the registry's own "no credential" error, by which point
/// the tag is pushed and the version spent. Repositories had started working
/// around that by hand-writing `[ -z "$PANTRY_REGISTRY_TOKEN" ]` guards into
/// their YAML; this is the same guard, run early enough to be worth something.
///
/// Everything here is read-only and costs nothing when a repository does not
/// publish to pantry: no workflow referencing a pantry secret means no `gh`
/// call at all.
fn checkPublishCredential(allocator: std.mem.Allocator) CredentialPreflight {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const wanted = workflowPantrySecrets(arena);
    if (wanted.items.len == 0) return .ok;

    const slug = originRepoSlug(arena) orelse return .undetermined;
    const configured = configuredSecretNames(arena, slug) orelse {
        style.print(
            "  {s}(could not read {s}'s secrets — releasing without checking that CI can publish){s}\n",
            .{ style.dim, slug, style.reset },
        );
        return .undetermined;
    };

    var missing = std.ArrayList([]const u8).empty;
    for (wanted.items) |name| {
        if (!containsName(configured.items, name)) {
            missing.append(arena, name) catch return .undetermined;
        }
    }
    if (missing.items.len == 0) return .ok;

    style.print("{s}error:{s} {s} has no secret named ", .{ style.red, style.reset, slug });
    for (missing.items, 0..) |name, i| {
        if (i > 0) style.print(" or ", .{});
        style.print("{s}{s}{s}", .{ style.yellow, name, style.reset });
    }
    style.print(", but its workflows read it.\n", .{});
    style.print("  The tag would be pushed and the publish would then fail in CI for want of a credential.\n\n", .{});
    style.print("  Store one, then put it where CI can read it:\n", .{});
    style.print("    pantry token set\n", .{});
    style.print("    pantry token sync --repo {s} --secret {s}\n\n", .{ slug, missing.items[0] });
    style.print("  Or release anyway — an environment secret is scoped to a deployment\n", .{});
    style.print("  environment and is not visible here, and a release need not publish:\n", .{});
    style.print("    pantry release ... --skip-token-check\n", .{});
    return .missing;
}

pub fn releaseCommand(allocator: std.mem.Allocator, options: ReleaseOptions) !CommandResult {
    // Guard: refuse to release from a dirty tree (would sweep unrelated changes
    // into the `chore: release` commit). Skipped for dry-run.
    if (!options.dry_run and !workingTreeClean(allocator)) {
        style.print("{s}error:{s} working tree is not clean.\n", .{ style.red, style.reset });
        style.print("  Commit or stash your changes before releasing.\n", .{});
        return .{ .exit_code = 1, .message = null };
    }

    // Before anything is written: can CI publish what this release produces?
    // A dry run gets the same report without the refusal — it writes nothing,
    // so there is nothing to protect, and "would this release work" is a fair
    // question to ask without credentials to hand.
    if (!options.skip_token_check) {
        const verdict = checkPublishCredential(allocator);
        if (verdict == .missing and !options.dry_run) return .{ .exit_code = 1, .message = null };
    }

    // Reconcile version drift (zon behind latest git tag) so the bump is always
    // monotonic and never clashes with an existing tag. Skipped for dry-run.
    if (!options.dry_run) reconcileVersionDrift(allocator);

    const current_str = readZonVersion(allocator) orelse getPackageVersion(allocator) orelse {
        return CommandResult.err(allocator, "No version found in build.zig.zon or package.json");
    };
    defer allocator.free(current_str);
    const current = SemVer.parse(current_str) orelse {
        return CommandResult.err(allocator, "Current version is not valid semver");
    };

    const new_version = computeNewVersion(allocator, current, options.release_type, options.preid) orelse {
        return CommandResult.err(allocator, "Invalid release type or version");
    };
    defer allocator.free(new_version);

    style.print("{s}>{s} {s} -> {s}{s}{s}\n", .{ style.dim, style.reset, current_str, style.green_bold, new_version, style.reset });

    if (options.dry_run) {
        style.print("  {s}(dry run — no changes applied){s}\n", .{ style.dim, style.reset });
        return .{ .exit_code = 0, .message = null };
    }

    // Apply the version to the config files.
    _ = writeZonVersion(allocator, new_version);
    writePackageJsonVersion(allocator, new_version);

    // Regenerate the changelog from git history.
    if (!options.no_changelog) generateChangelog(allocator, new_version);

    // Stage only the release-owned files.
    _ = gitRun(allocator, &.{ "git", "add", "build.zig.zon", "package.json", "CHANGELOG.md" });

    const commit_msg = try std.fmt.allocPrint(allocator, "chore: release v{s}", .{new_version});
    defer allocator.free(commit_msg);
    if (!gitRun(allocator, &.{ "git", "commit", "-m", commit_msg })) {
        return CommandResult.err(allocator, "git commit failed");
    }

    const tag = if (options.tag_name) |t| try allocator.dupe(u8, t) else try std.fmt.allocPrint(allocator, "v{s}", .{new_version});
    defer allocator.free(tag);
    if (!gitRun(allocator, &.{ "git", "tag", tag })) {
        return CommandResult.err(allocator, "git tag failed");
    }

    if (!options.no_push) {
        _ = gitRun(allocator, &.{ "git", "push" });
        _ = gitRun(allocator, &.{ "git", "push", "origin", tag });
    }

    style.print("\n{s}{s}{s} released {s}\n", .{ style.green, style.check, style.reset, tag });
    if (!options.no_push) {
        style.print("  {s}GitHub Action will create the release and publish to the registry{s}\n", .{ style.dim, style.reset });
    }
    return .{ .exit_code = 0, .message = null };
}

/// Read the `"version"` field from package.json in CWD. Caller owns the result.
fn getPackageVersion(allocator: std.mem.Allocator) ?[]const u8 {
    const content = io_helper.readFileAlloc(allocator, "package.json", 1 << 20) catch return null;
    defer allocator.free(content);
    const key = "\"version\"";
    const key_pos = std.mem.indexOf(u8, content, key) orelse return null;
    var i = key_pos + key.len;
    while (i < content.len and content[i] != '"') : (i += 1) {}
    if (i >= content.len) return null;
    i += 1;
    const start = i;
    while (i < content.len and content[i] != '"') : (i += 1) {}
    if (i >= content.len) return null;
    return allocator.dupe(u8, content[start..i]) catch null;
}

// ============================================================================
// Tests
// ============================================================================

const testing = std.testing;

test "a repo slug is read from every remote form git hands back" {
    try testing.expectEqualStrings("pantry-pm/pantry", parseRepoSlug("https://github.com/pantry-pm/pantry.git").?);
    try testing.expectEqualStrings("pantry-pm/pantry", parseRepoSlug("git@github.com:pantry-pm/pantry.git").?);
    try testing.expectEqualStrings("pantry-pm/pantry", parseRepoSlug("ssh://git@github.com/pantry-pm/pantry").?);
    try testing.expectEqualStrings("pantry-pm/pantry", parseRepoSlug("https://github.com/pantry-pm/pantry/").?);
}

test "a remote that is not one owner and one name is refused rather than guessed" {
    // Guessing would report a missing secret against a repository nobody
    // asked about, and the release would be refused over it. No answer is the
    // only safe reading of a URL this does not understand.
    try testing.expect(parseRepoSlug("https://gitlab.com/owner/name.git") == null);
    try testing.expect(parseRepoSlug("https://github.com/owner") == null);
    try testing.expect(parseRepoSlug("https://github.com/owner/name/extra") == null);
    try testing.expect(parseRepoSlug("https://github.com/") == null);
    try testing.expect(parseRepoSlug("github.com") == null);
}

test "the workflow scan finds whichever pantry secret names a repo chose" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var names = std.ArrayList([]const u8).empty;
    try collectPantrySecretRefs(arena,
        \\      env:
        \\        PANTRY_REGISTRY_TOKEN: ${{ secrets.PANTRY_REGISTRY_TOKEN }}
        \\        UNRELATED: ${{ secrets.NPM_TOKEN }}
        \\        OURS: ${{ secrets.HQ_PANTRY_TOKEN }}
        \\        AGAIN: ${{ secrets.PANTRY_REGISTRY_TOKEN }}
    , &names);

    // Two distinct names, and the repeat is not a third.
    try testing.expectEqual(@as(usize, 2), names.items.len);
    try testing.expectEqualStrings("PANTRY_REGISTRY_TOKEN", names.items[0]);
    try testing.expectEqualStrings("HQ_PANTRY_TOKEN", names.items[1]);
}

test "a workflow needing no pantry credential leaves nothing to ask GitHub about" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var names = std.ArrayList([]const u8).empty;
    try collectPantrySecretRefs(arena, "run: gh release create ${{ secrets.GITHUB_TOKEN }}", &names);
    // An empty set is what keeps the preflight free for repositories that do
    // not publish to pantry: no names, no `gh` call, no network.
    try testing.expectEqual(@as(usize, 0), names.items.len);
}
