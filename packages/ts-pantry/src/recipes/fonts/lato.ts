import type { Recipe } from '../../../scripts/recipe-types'
import { fontVersionFromTtf } from '../_lib/font-version'

// Auto-authored font recipe. Fonts install natively from pantry's registry into
// ~/Library/Fonts (see zig/src/install/native_apps.zig) — no Homebrew.
//
// Lato has no GitHub releases/appcast, but the font version is recorded in the
// TTF nametable. We read the version from Google Fonts' canonical
// Lato-Regular.ttf (a lightweight ~640KB file, e.g. 2.015) and publish the full
// family from the same repository. Using one canonical source prevents the
// version probe and artifact download from drifting apart.
export const recipe: Recipe = {
  domain: 'lato',
  name: 'Lato',
  description: 'A sans-serif typeface family by Łukasz Dziedzic.',
  homepage: 'https://www.latofonts.com/',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'linux/aarch64', 'linux/x86-64'],
  // Auto-update: read the version from the canonical Lato TTF nametable.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const v = await fontVersionFromTtf('https://github.com/google/fonts/raw/main/ofl/lato/Lato-Regular.ttf')
      return v ? [v] : []
    },
  },
  distributable: null,

  build: {
    script: [
      'mkdir -p {{prefix}}/share/fonts',
      'rm -rf /tmp/pantry-google-fonts',
      'git clone -q --depth 1 --filter=blob:none --sparse https://github.com/google/fonts.git /tmp/pantry-google-fonts',
      'git -C /tmp/pantry-google-fonts sparse-checkout set ofl/lato',
      'find /tmp/pantry-google-fonts/ofl/lato -type f \\( -iname \\*.ttf -o -iname \\*.otf \\) -exec cp -f {} {{prefix}}/share/fonts/ \\;',
      'test -n "$(find {{prefix}}/share/fonts -type f -print -quit)"',
    ],
  },
}
