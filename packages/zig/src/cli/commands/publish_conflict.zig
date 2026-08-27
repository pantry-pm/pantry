const std = @import("std");

/// How npm refused a version that is already spoken for.
pub const ConflictKind = enum { none, published, staged };

/// Classify an npm publish rejection that means "this version is taken".
///
/// npm has two of these and they are NOT the same event. `previously
/// published` is the ordinary one: the version is on the registry. `previously
/// staged` comes from trusted publishing, which accepts an upload and commits
/// it asynchronously — for a window the version is claimed but not yet
/// readable, so a GET says "absent" while a PUT says "taken".
///
/// Only the published wording was matched, so a staged conflict fell through
/// to the generic error path and failed the run. In a monorepo release that is
/// expensive: it fails AFTER the tag is cut and most packages are out, and if
/// the loser is a package that a sibling pins exactly, the sibling that did
/// publish is left uninstallable.
pub fn classifyConflict(code: ?[]const u8, message: ?[]const u8) ConflictKind {
    if (code) |c| {
        if (std.mem.eql(u8, c, "EPUBLISHCONFLICT")) return .published;
    }
    const msg = message orelse return .none;
    if (std.mem.indexOf(u8, msg, "previously staged version") != null or
        std.mem.indexOf(u8, msg, "Cannot publish over previously staged version") != null)
    {
        return .staged;
    }
    if (std.mem.indexOf(u8, msg, "cannot publish over the previously published version") != null or
        std.mem.indexOf(u8, msg, "Cannot publish over previously published version") != null or
        std.mem.indexOf(u8, msg, "You cannot publish over the previously published versions") != null)
    {
        return .published;
    }
    return .none;
}

test "classifyConflict distinguishes a staged version from a published one" {
    // The bug: only the published wording was matched, so npm's staged 409
    // fell through to the generic error path and failed a release that had
    // already tagged and pushed most of its packages.
    try std.testing.expectEqual(
        ConflictKind.staged,
        classifyConflict(null, "409 Cannot publish over previously staged version \"0.2.236\"."),
    );
    try std.testing.expectEqual(
        ConflictKind.published,
        classifyConflict(null, "Cannot publish over previously published version 1.0.0."),
    );
    try std.testing.expectEqual(
        ConflictKind.published,
        classifyConflict(null, "You cannot publish over the previously published versions: 1.0.0."),
    );
    try std.testing.expectEqual(
        ConflictKind.published,
        classifyConflict(null, "cannot publish over the previously published version"),
    );
}

test "classifyConflict reads the error code before the message" {
    try std.testing.expectEqual(
        ConflictKind.published,
        classifyConflict("EPUBLISHCONFLICT", null),
    );
    // A code that is not a conflict must not be promoted by a nil message.
    try std.testing.expectEqual(
        ConflictKind.none,
        classifyConflict("E401", null),
    );
}

test "classifyConflict leaves unrelated failures alone" {
    // Anything that is not a version conflict must stay a real failure —
    // skipping on these would report a package as released when it is not.
    try std.testing.expectEqual(ConflictKind.none, classifyConflict(null, null));
    try std.testing.expectEqual(ConflictKind.none, classifyConflict(null, ""));
    try std.testing.expectEqual(
        ConflictKind.none,
        classifyConflict(null, "401 Unauthorized: authentication token is invalid"),
    );
    try std.testing.expectEqual(
        ConflictKind.none,
        classifyConflict(null, "429 Too Many Requests"),
    );
    try std.testing.expectEqual(
        ConflictKind.none,
        classifyConflict(null, "You do not have permission to publish this package"),
    );
}
