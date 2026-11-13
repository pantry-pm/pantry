#!/bin/sh
# Run against the recipe's actual native executable, before publishing it.
set -eu
zig=$1
workspace=$(mktemp -d)
trap 'rm -rf "$workspace"' EXIT HUP INT TERM
cd "$workspace"
mkdir -p package/src first second
printf '%s\n' '.{ .name = .graphics_package_consumer, .version = "1.0.0", .fingerprint = 0xab1f9a8fd4d75f78, .paths = .{ "build.zig.zon", "src" } }' > package/build.zig.zon
printf '%s\n' 'pub const value: u32 = 42;' > package/src/main.zig
# Specify the two-file portable fixture: macOS's default tar can insert
# AppleDouble provenance files inside src, legitimately changing its hash.
tar --format=ustar -czf package.tar.gz package/build.zig.zon package/src/main.zig
export ZIG_GLOBAL_CACHE_DIR="$workspace/compiler"
expected=graphics_package_consumer-1.0.0-eF_X1KAAAAB7sPq4wQFLI6Urz5wPpAnB_liZ_wFl9Csi
for request in first second; do
  test -z "$(ls -A "$request")"
  actual=$("$zig" fetch --package-cache-dir "$workspace/$request" package.tar.gz)
  test "$actual" = "$expected"
  test -f "$request/p/$expected.tar.gz"
  test ! -e "compiler/p/$expected.tar.gz"
done
# --save must retain the real project's manifest and local checkout contract.
printf '%s\n' 'pub fn build(_: *@import("std").Build) void {}' > build.zig
printf '%s\n' '.{ .name = .consumer, .version = "0.0.0", .fingerprint = 0x705b372777268903, .paths = .{""} }' > build.zig.zon
"$zig" fetch --package-cache-dir "$workspace/first" --pkg-dir "$workspace/local-packages" --save=dep package.tar.gz
grep -F "$expected" build.zig.zon
test -d "local-packages/$expected"
test ! -e "compiler/p/$expected.tar.gz"
printf '%s\n' PANTRY_ZIG_PRIVATE_FETCH_CACHE_OK
