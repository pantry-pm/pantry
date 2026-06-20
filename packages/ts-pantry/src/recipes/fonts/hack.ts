import type { Recipe } from '../../scripts/recipe-types'

// Auto-authored font recipe. Fonts install natively from pantry's registry into
// ~/Library/Fonts (see zig/src/install/native_apps.zig) — no Homebrew.
export const recipe: Recipe = {
  domain: 'hack',
  name: 'Hack',
  description: 'A typeface designed for source code.',
  homepage: 'https://sourcefoundry.org/hack/',
  github: 'https://github.com/source-foundry/Hack',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'linux/aarch64', 'linux/x86-64'],
  versionSource: {
    type: 'github-releases',
    repo: 'source-foundry/Hack',
    tagPattern: /^v(.+)$/,
  },
  distributable: null,

  build: {
    script: [
      'mkdir -p {{prefix}}/share/fonts',
      'curl -fSL "https://github.com/source-foundry/Hack/releases/download/v{{version}}/Hack-v{{version}}-ttf.zip" -o /tmp/pantry-font.archive',
      'rm -rf /tmp/pantry-font-x && mkdir -p /tmp/pantry-font-x',
      'unzip -q -o /tmp/pantry-font.archive -d /tmp/pantry-font-x',
      "find /tmp/pantry-font-x -type f \\( -iname '*.ttf' -o -iname '*.otf' \\) -exec cp -f {} {{prefix}}/share/fonts/ \\;",
    ],
  },
}
