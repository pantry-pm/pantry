import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'the-unarchiver.com',
  name: 'The Unarchiver',
  description: 'A multi-format archive decompressor for macOS.',
  homepage: 'https://theunarchiver.com',
  programs: ['unar', 'lsar'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  // Track the Homebrew cask's marketing version (kept current by Homebrew's
  // livecheck/autobump) so the daily desktop updater republishes new releases.
  versionSource: {
    type: 'homebrew-cask',
    cask: 'the-unarchiver',
    versionField: 'marketing',
  },

  // Resolve the download URL from the SAME Homebrew cask we track for versioning
  // (pattern mirrors transmit.panic.com / hiddenbar.app) — one source of truth
  // that follows new releases automatically. The old hardcoded
  // cdn.theunarchiver.com/downloads/TheUnarchiver.zip was frozen at v3.11.1
  // (2016), which is how the registry ended up with bogus version data.
  build: {
    script: [
      'set -e',
      'BREW_URL=$(curl -fsSL "https://formulae.brew.sh/api/cask/the-unarchiver.json" | sed -nE \'s/.*"url":"([^"]+\\.(zip|dmg))".*/\\1/p\' | head -1)',
      'URL="${BREW_URL:?could not resolve The Unarchiver download URL from the Homebrew cask}"',
      'echo "Downloading The Unarchiver from $URL"',
      'curl -fSL -L --retry 3 "$URL" -o /tmp/unarchiver.zip',
      'rm -rf /tmp/unarchiver-x && mkdir -p /tmp/unarchiver-x',
      'unzip -qo /tmp/unarchiver.zip -d /tmp/unarchiver-x',
      'mkdir -p {{prefix}}',
      'APP=""; for a in /tmp/unarchiver-x/*.app; do [ -d "$a" ] && APP="$a" && break; done',
      '[ -n "$APP" ] || { echo "ERROR: The Unarchiver.app was not produced"; exit 1; }',
      'cp -R "$APP" "{{prefix}}/The Unarchiver.app"',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../The Unarchiver.app/Contents/MacOS/unar" {{prefix}}/bin/unar',
      'ln -sf "../The Unarchiver.app/Contents/MacOS/lsar" {{prefix}}/bin/lsar',
    ],
  },
}
