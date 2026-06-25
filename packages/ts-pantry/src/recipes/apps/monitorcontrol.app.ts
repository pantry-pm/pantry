import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'monitorcontrol.app',
  name: 'MonitorControl',
  description: 'A tool to control external monitor brightness and volume on macOS.',
  homepage: 'https://github.com/MonitorControl/MonitorControl',
  programs: ['monitorcontrol'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  github: 'https://github.com/MonitorControl/MonitorControl',
  // Track MonitorControl's own GitHub releases (no Homebrew). Asset is
  // `MonitorControl.<version>.dmg` (no `v` prefix in the filename).
  versionSource: {
    type: 'github-releases',
    repo: 'MonitorControl/MonitorControl',
    tagPattern: /^v(.+)$/,
  },

  build: {
    script: [
      'curl -fSL -L --retry 3 "https://github.com/MonitorControl/MonitorControl/releases/download/v{{version}}/MonitorControl.{{version}}.dmg" -o /tmp/monitorcontrol.dmg',
      'hdiutil attach /tmp/monitorcontrol.dmg -mountpoint /tmp/monitorcontrol-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/monitorcontrol-mount/MonitorControl.app" {{prefix}}/MonitorControl.app 2>/dev/null || \\',
      '  find /tmp/monitorcontrol-mount -maxdepth 1 -name "*.app" -exec cp -R {} {{prefix}}/ \\;',
      'hdiutil detach /tmp/monitorcontrol-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../MonitorControl.app/Contents/MacOS/MonitorControl" {{prefix}}/bin/monitorcontrol',
    ],
  },
}
