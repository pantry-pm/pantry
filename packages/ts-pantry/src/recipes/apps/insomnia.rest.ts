import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'insomnia.rest',
  name: 'Insomnia',
  description: 'A collaborative API client and design tool.',
  homepage: 'https://insomnia.rest',
  github: 'https://github.com/Kong/insomnia',
  programs: ['insomnia'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],
  // Kong tags Insomnia releases `core@<version>` (e.g. `core@13.0.2`), not
  // `v<version>` — so the old /^v(.+)$/ pattern never matched and `latest`
  // resolved to the raw, unusable `core@13.0.2`. Capture just the numeric
  // version, which is exactly what the build URL's {{version}} needs.
  versionSource: {
    type: 'github-releases',
    repo: 'Kong/insomnia',
    tagPattern: /^core@(.+)$/,
  },

  build: {
    script: [
      'curl -fSL -L "https://github.com/Kong/insomnia/releases/download/core%40{{version}}/Insomnia.Core-{{version}}.dmg" -o /tmp/insomnia.dmg',
      'hdiutil attach /tmp/insomnia.dmg -mountpoint /tmp/insomnia-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/insomnia-mount/Insomnia.app" {{prefix}}/Insomnia.app',
      'hdiutil detach /tmp/insomnia-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Insomnia.app/Contents/MacOS/Insomnia" {{prefix}}/bin/insomnia',
    ],
  },
}
