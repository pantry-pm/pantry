import type { Recipe } from '../../scripts/recipe-types'

// Auto-authored font recipe. Fonts install natively from pantry's registry into
// ~/Library/Fonts (see zig/src/install/native_apps.zig) — no Homebrew.
export const recipe: Recipe = {
  domain: 'jetbrains-mono-nerd-font.font',
  name: 'JetBrainsMono Nerd Font',
  description: 'JetBrains Mono patched with Nerd Font glyphs.',
  homepage: 'https://www.nerdfonts.com',
  github: 'https://github.com/ryanoasis/nerd-fonts',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'linux/aarch64', 'linux/x86-64'],
  versionSource: {
    type: 'github-releases',
    repo: 'ryanoasis/nerd-fonts',
    tagPattern: /^v(.+)$/,
  },
  distributable: null,

  build: {
    script: [
      'mkdir -p {{prefix}}/share/fonts',
      'curl -fSL "https://github.com/ryanoasis/nerd-fonts/releases/download/v{{version}}/JetBrainsMono.zip" -o /tmp/pantry-font.archive',
      'rm -rf /tmp/pantry-font-x && mkdir -p /tmp/pantry-font-x',
      'unzip -q -o /tmp/pantry-font.archive -d /tmp/pantry-font-x',
      "find /tmp/pantry-font-x -type f \\( -iname '*.ttf' -o -iname '*.otf' \\) -exec cp -f {} {{prefix}}/share/fonts/ \\;",
    ],
  },
}
