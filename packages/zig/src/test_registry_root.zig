const std = @import("std");

// Same trick as test_token_root.zig: a file's tests only run when the file is
// imported for its own sake, which `refAllDecls` does not do.
test {
    _ = @import("registry/endpoint.zig");
    _ = @import("cli/commands/registry_ops.zig");
    _ = @import("cli/commands/paid.zig");
    _ = @import("cli/commands/insure.zig");
}
