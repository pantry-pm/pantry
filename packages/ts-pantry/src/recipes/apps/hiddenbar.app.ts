import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'hiddenbar.app',
  name: 'Hidden Bar',
  description: 'A utility to hide menu bar items on macOS.',
  homepage: 'https://github.com/dwarvesf/hidden',
  programs: ['hiddenbar'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  github: 'https://github.com/dwarvesf/hidden',
  // Track Hidden Bar's own GitHub releases (no Homebrew). Asset is
  // `Hidden-Bar-v<version>-macos.zip`.
  versionSource: {
    type: 'github-releases',
    repo: 'dwarvesf/hidden',
    tagPattern: /^v(.+)$/,
  },

  build: {
    script: [
      'set -e',
      'curl -fSL -L --retry 3 "https://github.com/dwarvesf/hidden/releases/download/v{{version}}/Hidden-Bar-v{{version}}-macos.zip" -o /tmp/hiddenbar.zip',
      'cd /tmp && unzip -qo hiddenbar.zip',
      'mkdir -p {{prefix}}',
      '# Locate the produced .app via a glob in the physical CWD. `find /tmp` is',
      '# unreliable (on macOS /tmp is a symlink). Quote the destination — the',
      '# name contains a space, which previously split the mv into two args.',
      'cd "$(pwd -P)"',
      'APP=""; for a in *.app; do [ -d "$a" ] && APP="$a" && break; done',
      '[ -n "$APP" ] || { echo "ERROR: Hidden Bar.app was not produced"; exit 1; }',
      'mv "$APP" "{{prefix}}/Hidden Bar.app"',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Hidden Bar.app/Contents/MacOS/Hidden Bar" {{prefix}}/bin/hiddenbar',
    ],
  },
}
