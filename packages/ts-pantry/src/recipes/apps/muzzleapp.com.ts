import type { Recipe } from '../../scripts/recipe-types'

// Desktop app — installs natively from pantry's registry into /Applications
// (see zig/src/install/native_apps.zig). No Homebrew.
//
// Muzzle has no GitHub repo and no discoverable Sparkle appcast — the download
// is a build-numbered zip (muzzle-<build>.zip; build 426 == app version 1.9 from
// Info.plist). With no machine-readable version feed, the version is PINNED; the
// daily updater tracks it at the published version (no auto-bump). To ship a new
// release, bump `MUZZLE_BUILD` + knownVersions and re-publish.
const MUZZLE_BUILD = '426'

export const recipe: Recipe = {
  domain: 'muzzleapp.com',
  name: 'Muzzle',
  description: 'Silences notifications automatically while screen sharing.',
  homepage: 'https://muzzleapp.com',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  // No upstream version feed — pinned.
  versionSource: {
    type: 'url-pattern',
    url: `https://muzzleapp.com/binaries/muzzle-${MUZZLE_BUILD}.zip`,
    knownVersions: ['1.9'],
  },
  distributable: null,

  build: {
    script: [
      `curl -fSL -L "https://muzzleapp.com/binaries/muzzle-${MUZZLE_BUILD}.zip" -o /tmp/muzzle.zip`,
      'cd /tmp && rm -rf muzzle-x && mkdir -p muzzle-x && unzip -qo muzzle.zip -d muzzle-x',
      'mkdir -p {{prefix}}',
      'src_app="$(find /tmp/muzzle-x -maxdepth 2 -name "Muzzle.app" -not -path "*/__MACOSX/*" | head -1)" && cp -R "$src_app" {{prefix}}/Muzzle.app',
    ],
  },
}
