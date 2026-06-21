import type { Recipe } from '../../../scripts/recipe-types'
import { fontVersionFromTtf } from '../_lib/font-version'

// Auto-authored font recipe. Fonts install natively from pantry's registry into
// ~/Library/Fonts (see zig/src/install/native_apps.zig) — no Homebrew.
//
// Lato has no GitHub releases/appcast, but the font version is recorded in the
// TTF nametable. The latofonts.com OFL zip only serves the whole archive, so we
// read the version from Google Fonts' canonical Lato-Regular.ttf (a lightweight
// ~640KB file that ships the same release, e.g. 2.015) and the daily updater
// auto-republishes when it bumps. The actual download stays the latofonts.com
// OFL zip (the full upstream family).
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
      'curl -fSL "https://www.latofonts.com/files/Lato2OFL.zip" -o /tmp/pantry-font.archive',
      'rm -rf /tmp/pantry-font-x && mkdir -p /tmp/pantry-font-x',
      'unzip -q -o /tmp/pantry-font.archive -d /tmp/pantry-font-x',
      // Exclude __MACOSX AppleDouble (._*) shadow files that ship inside the zip.
      "find /tmp/pantry-font-x -type f \\( -iname '*.ttf' -o -iname '*.otf' \\) -not -name '._*' -not -path '*/__MACOSX/*' -exec cp -f {} {{prefix}}/share/fonts/ \\;",
    ],
  },
}
