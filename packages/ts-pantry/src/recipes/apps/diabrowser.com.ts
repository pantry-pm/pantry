import type { Recipe } from '../../scripts/recipe-types'

// Desktop app — installs natively from pantry's registry into /Applications
// (see zig/src/install/native_apps.zig). No Homebrew.
//
// Dia ships a versioned zip: Dia-<version>-<build>.zip (e.g. Dia-1.36.0-82312.zip).
// Dia self-updates via an embedded Sparkle feed, but the release host
// (releases.diabrowser.com) is a key/value object store with no public,
// machine-readable version index we could resolve from, and the marketing site
// exposes none either. So the version is PINNED — the daily updater tracks it at
// the published version (no auto-bump). To ship a new release, bump DIA_VERSION /
// DIA_BUILD + knownVersions and re-publish.
//
// NOTE: the Dia zip is ~710MB — publishing relies on the multipart upload path
// added to upload-to-s3.ts (single PutObject hangs on files this large).
const DIA_VERSION = '1.36.0'
const DIA_BUILD = '82312'

export const recipe: Recipe = {
  domain: 'diabrowser.com',
  name: 'Dia',
  description: 'An AI-native web browser by The Browser Company.',
  homepage: 'https://www.diabrowser.com',
  programs: [],
  platforms: ['darwin/aarch64'],
  // No public version feed — pinned.
  versionSource: {
    type: 'url-pattern',
    url: `https://releases.diabrowser.com/release/Dia-${DIA_VERSION}-${DIA_BUILD}.zip`,
    knownVersions: [DIA_VERSION],
  },
  distributable: null,

  build: {
    script: [
      `curl -fSL -L "https://releases.diabrowser.com/release/Dia-${DIA_VERSION}-${DIA_BUILD}.zip" -o /tmp/dia.zip`,
      'cd /tmp && rm -rf dia-x && mkdir -p dia-x && unzip -qo dia.zip -d dia-x',
      'mkdir -p {{prefix}}',
      'src_app="$(find /tmp/dia-x -maxdepth 2 -name "Dia.app" -not -path "*/__MACOSX/*" | head -1)" && cp -R "$src_app" {{prefix}}/Dia.app',
      'rm -rf /tmp/dia.zip /tmp/dia-x',
    ],
  },
}
