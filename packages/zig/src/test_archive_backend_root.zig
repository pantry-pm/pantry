// Reach the extractor tests explicitly; importing its callers does not discover them.
test {
    _ = @import("install/extractor.zig");
}
