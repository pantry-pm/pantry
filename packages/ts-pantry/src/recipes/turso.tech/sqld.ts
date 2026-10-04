import type { Recipe } from '../../../scripts/recipe-types'

// sqld (libsql-server) is the server `turso dev` starts, so the turso CLI is
// not usable without it on PATH. Upstream publishes self-contained release
// binaries (system frameworks/libc only) for darwin arm64/x86-64 and linux
// x86-64, and linux arm64 from 0.24.x; take those instead of a Rust build.
export const recipe: Recipe = {
  domain: 'turso.tech/sqld',
  // Not `sqld`: that name is the npm package (with per-platform builds),
  // and the catalog name would shadow it for `pantry install sqld`.
  name: 'libsql-server',
  description: 'libSQL server: the database server behind Turso and `turso dev`.',
  homepage: 'https://github.com/tursodatabase/libsql/tree/main/libsql-server',
  github: 'https://github.com/tursodatabase/libsql',
  programs: ['sqld'],
  versionSource: {
    type: 'github-releases',
    repo: 'tursodatabase/libsql',
    tagPattern: /^libsql-server-v(\d+\.\d+\.\d+)$/,
  },
  distributable: null,

  build: {
    script: [
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) TRIPLE=aarch64-apple-darwin ;;',
      '  darwin+x86-64)  TRIPLE=x86_64-apple-darwin ;;',
      '  linux+aarch64)  TRIPLE=aarch64-unknown-linux-gnu ;;',
      '  linux+x86-64)   TRIPLE=x86_64-unknown-linux-gnu ;;',
      '  *) echo "sqld: no upstream build for {{hw.platform}}/{{hw.arch}}" >&2; exit 42 ;;',
      'esac',
      'URL="https://github.com/tursodatabase/libsql/releases/download/libsql-server-v{{version}}/libsql-server-$TRIPLE.tar.xz"',
      '# Older releases ship no linux arm64 build: upstream has nothing, not a failure.',
      'curl -Lfo sqld.tar.xz "$URL" || { echo "sqld: $URL is not published" >&2; exit 42; }',
      'tar -xJf sqld.tar.xz',
      'mkdir -p {{prefix}}/bin',
      'install -m755 "libsql-server-$TRIPLE/sqld" {{prefix}}/bin/sqld',
    ],
  },
  test: {
    script: [
      'sqld --version',
      'sqld --version | grep {{version}}',
    ],
  },
}
