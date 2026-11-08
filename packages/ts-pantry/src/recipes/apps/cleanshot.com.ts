import type { Recipe } from '../../../scripts/recipe-types'
import { textVersionSource } from '../../../scripts/desktop-version-sources'

export const recipe: Recipe = {
  domain: 'cleanshot.com',
  name: 'CleanShot X',
  description: 'A screen capture and recording tool for macOS.',
  homepage: 'https://cleanshot.com',
  programs: ['cleanshot'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],

  versionSource: textVersionSource('https://cleanshot.com/changelog', /class=\x22number\x22[^>]*>([\d.]+)</),

  build: {
    script: [
      'curl --proto "=https" --tlsv1.2 -fSL --connect-timeout 30 --max-time 600 --retry 2 "https://updates.getcleanshot.com/v3/CleanShot-X-{{version}}.dmg" -o "$PWD/app.dmg"',
      'MOUNT="$PWD/mount"; mkdir -p "$MOUNT"',
      'trap \'hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true\' EXIT',
      'hdiutil attach "$PWD/app.dmg" -mountpoint "$MOUNT" -readonly -nobrowse -quiet',
      'mkdir -p "{{prefix}}"',
      'ditto --norsrc --noextattr --qtn "$MOUNT/CleanShot X.app" "{{prefix}}/CleanShot X.app"',
      'hdiutil detach "$MOUNT" -quiet; trap - EXIT',
      'mkdir -p "{{prefix}}/bin"',
      'ln -sf "../CleanShot X.app/Contents/MacOS/CleanShot X" "{{prefix}}/bin/cleanshot"',
    ],
  },
}
