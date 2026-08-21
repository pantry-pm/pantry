const std = @import("std");

// Same trick as test_token_root.zig: a file's tests only run when the file is
// imported for its own sake, which `refAllDecls` does not do.
test {
    _ = @import("registry/endpoint.zig");
    _ = @import("cli/commands/registry_ops.zig");
    _ = @import("cli/commands/paid.zig");
    _ = @import("cli/commands/insure.zig");
    // The npm/registry HTTP client (`auth/registry.zig`, not to be confused
    // with `registry/endpoint.zig` above). Its tests had never run: `lib.zig`
    // re-exports the file, and a re-export does not pull a file's tests in —
    // which is the whole reason this root exists. The publish-status rule lives
    // there, and it is exactly the kind of thing that must have a test that
    // actually executes: reading 202 as a failure cost a failed npm job on
    // every release until it was found by hand.
    _ = @import("auth/registry.zig");
}
