import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'the-unarchiver.com',
  name: 'The Unarchiver',
  description: 'A multi-format archive decompressor for macOS.',
  homepage: 'https://theunarchiver.com',
  programs: ['unar', 'lsar'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  // Resolve the version from MacPaw's official DevMate Sparkle appcast (no
  // Homebrew). The old hardcoded cdn.theunarchiver.com/.../TheUnarchiver.zip was
  // frozen at v3.11.1 (2016), which is how the registry got bogus version data.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const xml = await (await fetch('https://updates.devmate.com/com.macpaw.site.theunarchiver.xml', { redirect: 'follow' })).text()
      const m = xml.match(/sparkle:shortVersionString="([^"]+)"/)
      return m ? [m[1]] : []
    },
  },

  // Download the official MacPaw DevMate stable DMG — rolling (no build id in the
  // path), always the current release that matches the appcast version above.
  build: {
    script: [
      'set -e',
      'curl -fSL -L --retry 3 "https://dl.devmate.com/com.macpaw.site.theunarchiver/TheUnarchiver.dmg" -o /tmp/unarchiver.dmg',
      'hdiutil attach /tmp/unarchiver.dmg -mountpoint /tmp/unarchiver-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/unarchiver-mount/The Unarchiver.app" "{{prefix}}/The Unarchiver.app"',
      'hdiutil detach /tmp/unarchiver-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../The Unarchiver.app/Contents/MacOS/unar" {{prefix}}/bin/unar',
      'ln -sf "../The Unarchiver.app/Contents/MacOS/lsar" {{prefix}}/bin/lsar',
    ],
  },
}
