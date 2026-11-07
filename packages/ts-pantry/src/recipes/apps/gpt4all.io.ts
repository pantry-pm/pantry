import type { Recipe } from '../../../scripts/recipe-types'

/** The desktop app has its own identity; the legacy CLI uses calendar versions. */
export const recipe: Recipe = {
  domain: 'gpt4all.io', name: 'GPT4All',
  homepage: 'https://gpt4all.io', github: 'https://github.com/nomic-ai/gpt4all',
  platforms: ['darwin/aarch64'], programs: [],
  versionSource: { type: 'github-releases', repo: 'nomic-ai/gpt4all', tagPattern: /^v?(\d+(?:\.\d+){1,3})$/ },
  build: {
    script: [
      'curl -fL -o installer.dmg "https://github.com/nomic-ai/gpt4all/releases/download/v{{version}}/gpt4all-installer-macos-v{{version}}.dmg"',
      'mkdir -p "$PWD/mount"',
      'hdiutil attach -readonly -nobrowse -quiet installer.dmg -mountpoint "$PWD/mount"',
      "trap 'hdiutil detach -quiet \"$PWD/mount\"' EXIT",
      // The DMG holds Qt Installer Framework, not the application itself.
      'QT_QPA_PLATFORM=offscreen "$PWD/mount/gpt4all-installer-darwin.app/Contents/MacOS/gpt4all-installer-darwin" in --root "$PWD/payload" --cache-path "$PWD/installer-cache" --accept-licenses --default-answer --confirm-command',
      'test -d "$PWD/payload/bin/gpt4all.app"',
      'mkdir -p "{{prefix}}"',
      'mv "$PWD/payload/bin/gpt4all.app" "{{prefix}}/GPT4All.app"',
      'codesign --verify --deep --strict "{{prefix}}/GPT4All.app"',
    ],
  },
}
