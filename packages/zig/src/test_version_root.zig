// Same trick as test_token_root.zig: a file's tests only run when the file is
// imported for its own sake, which `refAllDecls` does not do.
//
// Version resolution against the binary registry: which key of a
// metadata.json `versions` object an install picks, and the prerelease
// detection and ordering it rests on.
test {
    _ = @import("install/registry_versions.zig");
    _ = @import("packages/semver.zig");
}
