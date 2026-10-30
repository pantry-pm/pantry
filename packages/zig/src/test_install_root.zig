// Import these files explicitly so their launch and install invariants run in CI.
test {
    _ = @import("io_helper.zig");
    _ = @import("cli/commands/install/core.zig");
    // Scope pinning: private scopes resolve from their Pantry registry only.
    // Rooted here rather than in test_registry_root.zig because reading a
    // manifest reaches the dependency parser, which needs zig_config.
    _ = @import("registry/scopes.zig");
    // `pantry access`: private package grants and package tokens.
    _ = @import("cli/commands/access.zig");
}
