import type { Recipe } from '../../scripts/recipe-types'

// Auto-authored font recipe. Fonts install natively from pantry's registry into
// ~/Library/Fonts (see zig/src/install/native_apps.zig) — no Homebrew.
//
// googlefonts/opensans has neither GitHub releases nor tags, so the version is
// PINNED (3.003 — the version embedded in the font files). The build downloads
// the repo archive and copies the TTFs from fonts/ttf. The daily updater tracks
// it at the published version (no auto-bump) until upstream tags a release.
export const recipe: Recipe = {
  domain: 'open-sans',
  name: 'Open Sans',
  description: 'A humanist sans-serif typeface designed by Steve Matteson.',
  homepage: 'https://fonts.google.com/specimen/Open+Sans',
  github: 'https://github.com/googlefonts/opensans',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'linux/aarch64', 'linux/x86-64'],
  // No releases/tags upstream — pinned to the repo's current font version.
  versionSource: {
    type: 'url-pattern',
    url: 'https://github.com/googlefonts/opensans/archive/refs/heads/main.zip',
    knownVersions: ['3.003'],
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
