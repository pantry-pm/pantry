import type { Recipe } from '../../../scripts/recipe-types'

// Desktop app — installs natively from pantry's registry into /Applications
// (see zig/src/install/native_apps.zig).
//
// Muzzle publishes a Sparkle appcast at https://muzzleapp.com/api/1/appcast.xml
// (no Homebrew needed). It gives the marketing version (1.9) and the
// build-numbered download URL (muzzle-<build>.zip), so both the versionSource
// and the build read straight from that official feed.
export const recipe: Recipe = {
  domain: 'muzzleapp.com',
  name: 'Muzzle',
  description: 'Silences notifications automatically while screen sharing.',
  homepage: 'https://muzzleapp.com',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const xml = await (await fetch('https://muzzleapp.com/api/1/appcast.xml')).text()
      const m = xml.match(/sparkle:shortVersionString="([^"]+)"/)
      return m ? [m[1]] : []
    },
  },
  distributable: null,

  build: {
    script: [
      'set -e',
      // Resolve the build-numbered download URL from the official appcast.
      'url=$(curl -fsSL "https://muzzleapp.com/api/1/appcast.xml" | grep -oE "https://muzzleapp\\.com/binaries/muzzle-[0-9]+\\.zip" | head -1)',
      '[ -n "$url" ] || { echo "could not resolve Muzzle download URL from appcast"; exit 1; }',
      'curl -fSL -L "$url" -o /tmp/muzzle.zip',
      'cd /tmp && rm -rf muzzle-x && mkdir -p muzzle-x && unzip -qo muzzle.zip -d muzzle-x',
      'mkdir -p {{prefix}}',
      'src_app="$(find /tmp/muzzle-x -maxdepth 2 -name "Muzzle.app" -not -path "*/__MACOSX/*" | head -1)" && cp -R "$src_app" {{prefix}}/Muzzle.app',
      'rm -rf /tmp/muzzle.zip /tmp/muzzle-x',
    ],
  },
}
