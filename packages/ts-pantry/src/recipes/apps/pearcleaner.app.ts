import type { Recipe } from '../../scripts/recipe-types'

// Desktop app — installs natively from pantry's registry into /Applications
// (see zig/src/install/native_apps.zig). No Homebrew. Pearcleaner.zip is the
// universal (arm64 + x86_64) build.
export const recipe: Recipe = {
  domain: 'pearcleaner.app',
  name: 'Pearcleaner',
  description: 'Open-source application uninstaller for macOS.',
  homepage: 'https://github.com/alienator88/Pearcleaner',
  github: 'https://github.com/alienator88/Pearcleaner',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  versionSource: {
    type: 'github-releases',
    repo: 'alienator88/Pearcleaner',
    tagPattern: /^v?(.+)$/,
  },
  distributable: null,

  build: {
    script: [
      'curl -fSL -L "https://github.com/alienator88/Pearcleaner/releases/download/{{version}}/Pearcleaner.zip" -o /tmp/pearcleaner.zip',
      'cd /tmp && rm -rf pearcleaner-x && mkdir -p pearcleaner-x && unzip -qo pearcleaner.zip -d pearcleaner-x',
      'mkdir -p {{prefix}}',
      // The zip ships a __MACOSX/Pearcleaner.app AppleDouble shadow alongside the
      // real bundle — exclude it so we copy the app with the actual Mach-O binaries.
      'src_app="$(find /tmp/pearcleaner-x -maxdepth 2 -name "Pearcleaner.app" -not -path "*/__MACOSX/*" | head -1)" && cp -R "$src_app" {{prefix}}/Pearcleaner.app',
    ],
  },
}
