import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'spacetimedb.com',
  name: 'spacetime',
  description: 'Multiplayer at the speed of light',
  homepage: 'https://spacetimedb.com',
  github: 'https://github.com/clockworklabs/SpacetimeDB',
  programs: ['spacetime'],
  versionSource: {
    type: 'github-releases',
    repo: 'clockworklabs/SpacetimeDB',
    tagPattern: /^v(.+)$/,
  },

  build: {
    script: [
      'case {{hw.platform}}/{{hw.arch}} in',
      '  darwin/aarch64) TRIPLE="aarch64-apple-darwin" ;;',
      '  darwin/x86-64) TRIPLE="x86_64-apple-darwin" ;;',
      '  linux/x86-64) TRIPLE="x86_64-unknown-linux-gnu" ;;',
      '  linux/aarch64) TRIPLE="aarch64-unknown-linux-gnu" ;;',
      '  *) echo "Unsupported platform" && exit 42 ;;',
      'esac',
      // Work inside the build directory: a fixed /tmp path survives into the
      // next version built on the same runner, and `find | head -1` would then
      // install a stale binary.
      'curl -fSL -o spacetime.tar.gz "https://github.com/clockworklabs/SpacetimeDB/releases/download/v{{version}}/spacetime-${TRIPLE}.tar.gz"',
      'rm -rf spacetime-extract',
      'mkdir -p spacetime-extract {{prefix}}/bin',
      'tar -xzf spacetime.tar.gz -C spacetime-extract',
      // Archives up to the 2023 calendar releases hold one `spacetime` binary.
      // 1.x/2.x archives hold `spacetimedb-cli`, which is the `spacetime`
      // command, and `spacetimedb-standalone`, the server that `spacetime
      // start` execs as a sibling of the running CLI (resolve_sibling_binary in
      // crates/cli/src/subcommands/start.rs), so both are installed side by side.
      'CLI="$(find spacetime-extract -type f \\( -name spacetime -o -name spacetimedb-cli \\) | head -1)"',
      'if [ -z "$CLI" ]; then echo "no spacetime CLI in spacetime-${TRIPLE}.tar.gz" >&2; exit 1; fi',
      'cp "$CLI" {{prefix}}/bin/spacetime',
      'chmod +x {{prefix}}/bin/spacetime',
      'STANDALONE="$(find spacetime-extract -type f -name spacetimedb-standalone | head -1)"',
      'if [ -n "$STANDALONE" ]; then',
      '  cp "$STANDALONE" {{prefix}}/bin/spacetimedb-standalone',
      '  chmod +x {{prefix}}/bin/spacetimedb-standalone',
      'fi',
    ],
  },
}
