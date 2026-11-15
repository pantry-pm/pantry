import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'nodejs.org',
  name: 'node',
  description: 'Platform built on V8 to build network applications',
  homepage: 'https://nodejs.org/',
  github: 'https://github.com/nodejs/node',
  programs: ['node'],
  versionSource: {
    type: 'github-releases',
    repo: 'nodejs/node',
  },
  // Node's official release archive, repackaged. Compiling V8 does not fit in a
  // build slot, and the source recipe this replaces could not run at all: the
  // YAML port dropped every `if:` and `working-directory:` (it ran both
  // configure entry points, then `cd`-ed into deps/v8/src/builtins from inside
  // deps/v8/src/wasm). pkgx prebuilts are still mirrored first where they
  // exist; this covers the releases pkgx never built for a platform.
  distributable: null,
  dependencies: {
    // The mirrored pkgx builds link these three shared; the official binary
    // carries its own copies and loads none of them.
    'unicode.org': '^73',
    'openssl.org': '1.1',
    'zlib.net': '1',
    linux: {
      // The official binary needs libatomic.so.1. libstdc++ and libgcc are
      // part of the base system as far as publication is concerned.
      'gnu.org/gcc/libatomic': '*',
    },
  },

  build: {
    script: [
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) TARGET="darwin-arm64" ;;',
      '  darwin+x86-64) TARGET="darwin-x64" ;;',
      '  linux+aarch64) TARGET="linux-arm64" ;;',
      '  linux+x86-64) TARGET="linux-x64" ;;',
      '  *) echo "unsupported platform {{hw.platform}}/{{hw.arch}}" >&2; exit 42 ;;',
      'esac',
      'ARCHIVE="node-v{{version}}-$TARGET.tar.gz"',
      // Dependencies prepend their libraries to the loader path; fetching the
      // archive is a host operation, so run the host curl in its own library
      // environment. An HTTP error (curl 22) means upstream ships no archive
      // for this platform at this version: exit 42, the download-failure code.
      'FETCH="env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH /usr/bin/curl -fSL --retry 3"',
      '$FETCH -o "$ARCHIVE" "https://nodejs.org/dist/v{{version}}/$ARCHIVE" || { [ $? -eq 22 ] && exit 42; exit 1; }',
      '$FETCH -o SHASUMS256.txt "https://nodejs.org/dist/v{{version}}/SHASUMS256.txt"',
      // Verify against the release's own checksum list before unpacking.
      'EXPECTED=$(awk -v archive="$ARCHIVE" \'$2 == archive { print $1 }\' SHASUMS256.txt)',
      'if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$ARCHIVE" | cut -d" " -f1); else ACTUAL=$(shasum -a 256 "$ARCHIVE" | cut -d" " -f1); fi',
      'if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then echo "checksum mismatch for $ARCHIVE: expected ${EXPECTED:-none}, got $ACTUAL" >&2; exit 1; fi',
      'mkdir node-release',
      'tar -xzf "$ARCHIVE" -C node-release --strip-components=1',
      // node only: npm, npx and corepack are their own packages (npmjs.com,
      // nodejs.org/corepack), as in the `--without-npm` source build.
      'install -d {{prefix}}/bin {{prefix}}/share',
      'install -m 755 node-release/bin/node {{prefix}}/bin/node',
      'cp -R node-release/include {{prefix}}/include',
      'if [ -d node-release/share/man ]; then cp -R node-release/share/man {{prefix}}/share/man; fi',
      'if [ -d node-release/share/doc ]; then cp -R node-release/share/doc {{prefix}}/share/doc; fi',
    ],
  },
  test: {
    script: [
      'test "$(node --version)" = "v{{version}}"',
      'test "$(node -e \'console.log("Hello, world!")\')" = "Hello, world!"',
    ],
  },
}
