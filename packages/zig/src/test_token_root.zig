const std = @import("std");

// `_ = @import(...)` inside a test block is what pulls a file's own tests into
// the compilation. Re-exported decls do not, so the credential store's tests
// were compiled but never run until this root existed.
test {
    _ = @import("cli/commands/token.zig");
}
