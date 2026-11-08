import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'lmstudio.ai',
  name: 'LM Studio',
  description: 'A desktop app for discovering, downloading, and running local LLMs.',
  homepage: 'https://lmstudio.ai',
  programs: ['lm-studio'],
  // LM Studio's macOS distribution supports Apple Silicon.
  platforms: ['darwin/aarch64'],
  // CDN filenames carry a build suffix; the signed bundle owns the app version.
  versionSource: { type: 'desktop-bundle', url: 'https://lmstudio.ai/download/latest/darwin/arm64', bundle: 'LM Studio.app', format: 'dmg' },
  build: {
    script: [
      'curl --proto "=https" --tlsv1.2 -fSL --connect-timeout 30 --max-time 600 --retry 2 "https://lmstudio.ai/download/latest/darwin/arm64" -o "$PWD/lmstudio.dmg"',
      'MOUNT="$PWD/lm-studio-mount" && mkdir -p "$MOUNT"',
      'trap \'hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true\' EXIT',
      'hdiutil attach "$PWD/lmstudio.dmg" -mountpoint "$MOUNT" -readonly -nobrowse -quiet',
      'test -d "$MOUNT/LM Studio.app"',
      'mkdir -p "{{prefix}}/bin"',
      'ditto --norsrc --noextattr --qtn "$MOUNT/LM Studio.app" "{{prefix}}/LM Studio.app"',
      'ln -sf "../LM Studio.app/Contents/MacOS/LM Studio" "{{prefix}}/bin/lm-studio"',
    ],
  },
}
