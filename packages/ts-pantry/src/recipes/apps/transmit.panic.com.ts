import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'transmit.panic.com',
  name: 'Transmit',
  description: 'A file transfer client for macOS.',
  homepage: 'https://panic.com/transmit',
  programs: ['transmit'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  // Resolve the version from Panic's own Sparkle appcast (no Homebrew). NOTE:
  // appName MUST be `Transmit 5` — `appName=Transmit` returns the stale
  // Transmit 4 feed. The build downloads the matching versioned zip below.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const url = 'https://www.panic.com/updates/update.php?osVersion=14.6.0&appName=Transmit%205&appVersion=5.0.0'
      const xml = await (await fetch(url)).text()
      // Appcast is newest-first; take the first enclosure's short version string.
      const m = xml.match(/sparkle:shortVersionString="([^"]+)"/)
      return m ? [m[1]] : []
    },
  },

  build: {
    script: [
      'set -e',
      // Official Panic download, templated by version (the appcast enclosure URL).
      'URL="https://download.panic.com/transmit/Transmit%20{{version}}.zip"',
      'echo "Downloading Transmit from $URL"',
      'curl -fSL -L --retry 3 "$URL" -o /tmp/transmit.zip',
      'cd /tmp && unzip -qo transmit.zip',
      'mkdir -p {{prefix}}',
      '# Glob in the physical CWD; `find /tmp` is unreliable (macOS /tmp symlink).',
      'cd "$(pwd -P)"',
      'APP=""; for a in *.app; do [ -d "$a" ] && APP="$a" && break; done',
      '[ -n "$APP" ] || { echo "ERROR: Transmit.app was not produced"; exit 1; }',
      'mv "$APP" "{{prefix}}/Transmit.app"',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Transmit.app/Contents/MacOS/Transmit" {{prefix}}/bin/transmit',
    ],
  },
}
