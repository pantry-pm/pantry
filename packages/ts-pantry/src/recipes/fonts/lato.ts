import type { Recipe } from '../../scripts/recipe-types'

// Auto-authored font recipe. Fonts install natively from pantry's registry into
// ~/Library/Fonts (see zig/src/install/native_apps.zig) — no Homebrew.
//
// Lato ships a single OFL zip (Lato2OFL.zip) with no version in the URL and no
// GitHub releases/tags feed, so the version is PINNED. The daily updater tracks
// it at the published version (no auto-bump) until a new release is cut.
export const recipe: Recipe = {
  domain: 'lato',
  name: 'Lato',
  description: 'A sans-serif typeface family by Łukasz Dziedzic.',
  homepage: 'https://www.latofonts.com/',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'linux/aarch64', 'linux/x86-64'],
  // No upstream version feed (single fixed zip URL) — pinned.
  versionSource: {
    type: 'url-pattern',
    url: 'https://www.latofonts.com/files/Lato2OFL.zip',
    knownVersions: ['2.0'],
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
