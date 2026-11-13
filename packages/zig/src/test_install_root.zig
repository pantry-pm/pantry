// Import these files explicitly so their launch and install invariants run in CI.
test {
    _ = @import("deps/detector.zig");
    _ = @import("io_helper.zig");
    // The install failure report and transient-failure classification.
    _ = @import("cli/style.zig");
    _ = @import("cli/commands/install/core.zig");
    _ = @import("cli/commands/install/workspace.zig");
    // Scope pinning: private scopes resolve from their Pantry registry only.
    // Rooted here rather than in test_registry_root.zig because reading a
    // manifest reaches the dependency parser, which needs zig_config.
    _ = @import("registry/scopes.zig");
    // `pantry access`: private package grants and package tokens.
    _ = @import("cli/commands/access.zig");
    // `pantry publish` to a Pantry registry: rejection hints, visibility.
    _ = @import("cli/commands/registry.zig");
    // `pantry release`'s preflight: which repository it would ask GitHub
    // about, and which secret names its workflows read. It belongs with the
    // publish commands above rather than with the credential store, and it
    // has to be here: importing it into test_token_root.zig instead drags
    // shell/commands.zig's own tests into that binary, where two of them fail
    // although the same tests pass in this one.
    _ = @import("cli/commands/release.zig");
}
