import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'crates.io/eza',
  name: 'eza',
  programs: [
    'eza',
  ],
  // Runtime deps. openssl + zlib are pulled in transitively by libgit2's
  // ssh/https support (libssh2 → openssl). We declare them explicitly so the
  // build links OUR copies — see OPENSSL_DIR below — instead of the GitHub
  // runner's preinstalled Homebrew openssl, whose absolute path
  // (/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib) otherwise gets baked into
  // the published binary and fails to load on a machine without Homebrew.
  dependencies: {
    'libgit2.org': '~1.7',
    'openssl.org': '^3',
    'zlib.net': '^1.2',
  },
  buildDependencies: {
    'rust-lang.org': '>=1.65',
    'rust-lang.org/cargo': '*',
    'freedesktop.org/pkg-config': '^0.29',
  },
  distributable: {
    url: 'https://github.com/eza-community/eza/archive/refs/tags/v{{ version }}.tar.gz',
    stripComponents: 1,
  },
  build: {
    script: [
      'cargo install --locked --path . --root {{prefix}}',
    ],
    env: {
      // Point the openssl-sys / libssh2-sys crates at Pantry's openssl so the
      // resulting binary references it (resolved via the recipe's rpath) rather
      // than a hardcoded Homebrew path.
      OPENSSL_DIR: '{{deps.openssl.org.prefix}}',
      OPENSSL_NO_VENDOR: '1',
      // Let pkg-config discover the Pantry-provided libraries during the build.
      PKG_CONFIG_PATH: [
        '{{deps.openssl.org.prefix}}/lib/pkgconfig',
        '{{deps.libgit2.org.prefix}}/lib/pkgconfig',
        '{{deps.zlib.net.prefix}}/lib/pkgconfig',
      ],
    },
  },
  test: {
    script: [
      'eza --version | grep {{version}}',
    ],
  },
}
