import type { Recipe } from '../../scripts/recipe-types'

// Desktop app — installs natively from pantry's registry into /Applications
// (see zig/src/install/native_apps.zig).
//
// Muzzle has no GitHub repo and no public Sparkle appcast, but it IS a Homebrew
// cask (`muzzle`). Homebrew tracks its version+build (`1.9,426`) and the matching
// download URL, kept current by Homebrew's livecheck/autobump — so we resolve the
// latest version from the Cask API and auto-republish new releases.
//
// The download URL is build-numbered (muzzle-<build>.zip), so the build script
// reads the cask's resolved `url` straight from the Homebrew API at build time
// rather than hardcoding a build number that would drift.
export const recipe: Recipe = {
  domain: 'muzzleapp.com',
  name: 'Muzzle',
  description: 'Silences notifications automatically while screen sharing.',
  homepage: 'https://muzzleapp.com',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  versionSource: {
    type: 'homebrew-cask',
    cask: 'muzzle',
    versionField: 'marketing', // publish the marketing version (1.9), not the build (426)
  },
  distributable: null,

  build: {
    script: [
      // Resolve the current download URL from the Homebrew cask (build-numbered).
      'url="$(curl -fsSL https://formulae.brew.sh/api/cask/muzzle.json | python3 -c "import sys,json;print(json.load(sys.stdin)[\\"url\\"])")"',
      'curl -fSL -L "$url" -o /tmp/muzzle.zip',
      'cd /tmp && rm -rf muzzle-x && mkdir -p muzzle-x && unzip -qo muzzle.zip -d muzzle-x',
      'mkdir -p {{prefix}}',
      'src_app="$(find /tmp/muzzle-x -maxdepth 2 -name "Muzzle.app" -not -path "*/__MACOSX/*" | head -1)" && cp -R "$src_app" {{prefix}}/Muzzle.app',
      'rm -rf /tmp/muzzle.zip /tmp/muzzle-x',
    ],
  },
}
