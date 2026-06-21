import type { Recipe } from '../../../scripts/recipe-types'

// Auto-authored font recipe. Fonts install natively from pantry's registry into
// ~/Library/Fonts (see zig/src/install/native_apps.zig) — no Homebrew.
//
// adobe-fonts/source-code-pro publishes GitHub releases, but the tags are a
// triple like `2.042R-u/1.062R-i/1.026R-vf`. We extract the upright family
// version (2.042) via tagPattern so the daily updater tracks it. The build pulls
// the published OTFs straight from the repo's default `release` branch (where
// Adobe keeps the shipped fonts), which always matches the latest release.
export const recipe: Recipe = {
  domain: 'source-code-pro',
  name: 'Source Code Pro',
  description: 'Monospaced font family for user interface and coding environments.',
  homepage: 'https://github.com/adobe-fonts/source-code-pro',
  github: 'https://github.com/adobe-fonts/source-code-pro',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'linux/aarch64', 'linux/x86-64'],
  versionSource: {
    type: 'github-releases',
    repo: 'adobe-fonts/source-code-pro',
    // Tag e.g. "2.042R-u/1.062R-i/1.026R-vf" → extract the upright version "2.042".
    tagPattern: /^(\d+\.\d+)R/,
  },
  distributable: null,

  build: {
    script: [
      'mkdir -p {{prefix}}/share/fonts',
      // The `release` branch is the repo default and holds the shipped OTF/TTF.
      'curl -fSL -L "https://github.com/adobe-fonts/source-code-pro/archive/refs/heads/release.zip" -o /tmp/pantry-font.archive',
      'rm -rf /tmp/pantry-font-x && mkdir -p /tmp/pantry-font-x',
      'unzip -q -o /tmp/pantry-font.archive -d /tmp/pantry-font-x',
      // Copy only the OTF directory's fonts (the repo also vendors source/build files).
      "find /tmp/pantry-font-x -type f -path '*/OTF/*' -iname '*.otf' -not -name '._*' -not -path '*/__MACOSX/*' -exec cp -f {} {{prefix}}/share/fonts/ \\;",
    ],
  },
}
