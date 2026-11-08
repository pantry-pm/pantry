import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'brave.com',
  name: 'Brave Browser',
  description: 'A privacy-focused web browser that blocks ads and trackers.',
  homepage: 'https://brave.com',
  programs: ['brave'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],

  // Brave embeds the Chromium major before its own exact product version.
  bundleVersionPattern: /^\d+\.(\d+\.\d+\.\d+)$/,
  versionSource: { type: 'github-releases', repo: 'brave/brave-browser', tagPattern: /^v?(\d+(?:\.\d+){1,3})$/ },

  build: {
    script: [
      'if test {{hw.arch}} = "aarch64"; then ARCH="arm64"; else ARCH="x64"; fi',
      'curl --proto "=https" --tlsv1.2 -fSL --connect-timeout 30 --max-time 600 --retry 2 "https://github.com/brave/brave-browser/releases/download/v{{version}}/Brave-Browser-${ARCH}.dmg" -o "$PWD/app.dmg"',
      'MOUNT="$PWD/mount"; mkdir -p "$MOUNT"',
      'trap \'hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true\' EXIT',
      'hdiutil attach "$PWD/app.dmg" -mountpoint "$MOUNT" -readonly -nobrowse -quiet',
      'mkdir -p "{{prefix}}"',
      'ditto --norsrc --noextattr --qtn "$MOUNT/Brave Browser.app" "{{prefix}}/Brave Browser.app"',
      'hdiutil detach "$MOUNT" -quiet; trap - EXIT',
      'mkdir -p "{{prefix}}/bin"',
      'ln -sf "../Brave Browser.app/Contents/MacOS/Brave Browser" "{{prefix}}/bin/brave"',
    ],
  },
}
