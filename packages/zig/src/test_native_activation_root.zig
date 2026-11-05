// Explicitly import activation fixtures so their public-interface tests run in CI.
test {
    _ = @import("install/symlink.zig");
}
