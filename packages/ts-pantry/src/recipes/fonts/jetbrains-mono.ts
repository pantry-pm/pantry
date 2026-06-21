import type { Recipe } from '../../../scripts/recipe-types'

// Auto-authored font recipe. Fonts install natively from pantry's registry into
// ~/Library/Fonts (see zig/src/install/native_apps.zig) — no Homebrew.
export const recipe: Recipe = {
  domain: 'jetbrains-mono',
  name: 'JetBrains Mono',
  description: 'A typeface for developers.',
  homepage: 'https://www.jetbrains.com/lp/mono/',
  github: 'https://github.com/JetBrains/JetBrainsMono',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'linux/aarch64', 'linux/x86-64'],
  versionSource: {
    type: 'github-releases',
    repo: 'JetBrains/JetBrainsMono',
    tagPattern: /^v(.+)$/,
  },
  distributable: null,

  build: {
    script: [
      'mkdir -p {{prefix}}/share/fonts',
      'curl -fSL "https://github.com/JetBrains/JetBrainsMono/releases/download/v{{version}}/JetBrainsMono-{{version}}.zip" -o /tmp/pantry-font.archive',
      'rm -rf /tmp/pantry-font-x && mkdir -p /tmp/pantry-font-x',
      'unzip -q -o /tmp/pantry-font.archive -d /tmp/pantry-font-x',
      "find /tmp/pantry-font-x -type f \\( -iname '*.ttf' -o -iname '*.otf' \\) -exec cp -f {} {{prefix}}/share/fonts/ \\;",
    ],
  },
}
