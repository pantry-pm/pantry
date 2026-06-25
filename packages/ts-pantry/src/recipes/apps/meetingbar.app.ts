import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'meetingbar.app',
  name: 'MeetingBar',
  description: 'A menu bar app for your calendar meetings.',
  homepage: 'https://meetingbar.app',
  programs: ['meetingbar'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  github: 'https://github.com/leits/MeetingBar',
  // Track MeetingBar's own GitHub releases (no Homebrew). The DMG asset has a
  // static name (`MeetingBar.dmg`); the version lives in the release tag path.
  versionSource: {
    type: 'github-releases',
    repo: 'leits/MeetingBar',
    tagPattern: /^v(.+)$/,
  },

  build: {
    script: [
      'curl -fSL -L --retry 3 "https://github.com/leits/MeetingBar/releases/download/v{{version}}/MeetingBar.dmg" -o /tmp/meetingbar.dmg',
      'hdiutil attach /tmp/meetingbar.dmg -mountpoint /tmp/meetingbar-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/meetingbar-mount/MeetingBar.app" {{prefix}}/MeetingBar.app 2>/dev/null || \\',
      '  find /tmp/meetingbar-mount -maxdepth 1 -name "*.app" -exec cp -R {} {{prefix}}/ \\;',
      'hdiutil detach /tmp/meetingbar-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../MeetingBar.app/Contents/MacOS/MeetingBar" {{prefix}}/bin/meetingbar',
    ],
  },
}
