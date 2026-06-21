import type { Recipe } from '../../../scripts/recipe-types'
import { fontVersionFromTtf } from '../_lib/font-version'

// Auto-authored font recipe. Fonts install natively from pantry's registry into
// ~/Library/Fonts (see zig/src/install/native_apps.zig) — no Homebrew.
//
// googlefonts/opensans has no GitHub releases/tags, but the font version lives in
// the TTF nametable (e.g. 3.003). We read it from the same repo TTF the build
// ships, so the daily updater auto-republishes whenever upstream bumps the font.
export const recipe: Recipe = {
  domain: 'open-sans',
  name: 'Open Sans',
  description: 'A humanist sans-serif typeface designed by Steve Matteson.',
  homepage: 'https://fonts.google.com/specimen/Open+Sans',
  github: 'https://github.com/googlefonts/opensans',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'linux/aarch64', 'linux/x86-64'],
  // Auto-update: read the version from the repo's Open Sans TTF nametable.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const v = await fontVersionFromTtf('https://github.com/googlefonts/opensans/raw/main/fonts/ttf/OpenSans-Regular.ttf')
      return v ? [v] : []
    },
  },
  distributable: null,

  build: {
    script: [
      'mkdir -p {{prefix}}/share/fonts',
      'curl -fSL -L "https://github.com/googlefonts/opensans/archive/refs/heads/main.zip" -o /tmp/pantry-font.archive',
      'rm -rf /tmp/pantry-font-x && mkdir -p /tmp/pantry-font-x',
      'unzip -q -o /tmp/pantry-font.archive -d /tmp/pantry-font-x',
      // Copy the static TTFs (skip variable/condensed-only dirs are fine to include).
      "find /tmp/pantry-font-x -type f \\( -iname '*.ttf' -o -iname '*.otf' \\) -not -name '._*' -not -path '*/__MACOSX/*' -exec cp -f {} {{prefix}}/share/fonts/ \\;",
    ],
  },
}
