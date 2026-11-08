import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'meetingbar.app',
  name: 'MeetingBar',
  description: 'A menu bar app for your calendar meetings.',
  homepage: 'https://meetingbar.app',
  programs: ['meetingbar'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  github: 'https://github.com/leits/MeetingBar',
  // Vendor release tags can differ from the signed bundle (v5.0.0 contains 5.0.1).
  // Read the actual marketing version and bind publication to the archive validators.
  versionSource: {
    type: 'desktop-bundle',
    url: 'https://github.com/leits/MeetingBar/releases/latest/download/MeetingBar.dmg',
    format: 'dmg',
    bundle: 'MeetingBar.app',
  },

  build: {
    script: [
      'curl --proto "=https" --tlsv1.2 -fSL --connect-timeout 30 --max-time 600 --retry 2 "https://github.com/leits/MeetingBar/releases/latest/download/MeetingBar.dmg" -o "$PWD/app.dmg"',
      'MOUNT="$PWD/mount"; mkdir -p "$MOUNT"',
      'trap \'hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true\' EXIT',
      'hdiutil attach "$PWD/app.dmg" -mountpoint "$MOUNT" -readonly -nobrowse -quiet',
      'mkdir -p "{{prefix}}"',
      'ditto --norsrc --noextattr --qtn "$MOUNT/MeetingBar.app" "{{prefix}}/MeetingBar.app"',
      'hdiutil detach "$MOUNT" -quiet; trap - EXIT',
      'mkdir -p "{{prefix}}/bin"',
      'ln -sf "../MeetingBar.app/Contents/MacOS/MeetingBar" "{{prefix}}/bin/meetingbar"',
    ],
  },
}
