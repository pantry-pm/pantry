import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'lmstudio.ai',
  name: 'LM Studio',
  description: 'A desktop app for discovering, downloading, and running local LLMs.',
  homepage: 'https://lmstudio.ai',
  programs: ['lm-studio'],
  // LM Studio's macOS build is Apple-Silicon only (the x64 download endpoint
  // 400s), so we ship darwin/aarch64 only.
  platforms: ['darwin/aarch64'],
  // Resolve the version from LM Studio's own official download redirect (no
  // Homebrew): the latest URL redirects to LM-Studio-<version>-arm64.dmg. The
  // build downloads that same rolling URL below.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const res = await fetch('https://lmstudio.ai/download/latest/darwin/arm64', { method: 'HEAD', redirect: 'follow' })
      const m = res.url.match(/LM-Studio-([\d.\-]+)-arm64\.dmg/i)
      return m ? [m[1]] : []
    },
  },

  build: {
    script: [
      'curl -fSL -L --retry 3 "https://lmstudio.ai/download/latest/darwin/arm64" -o /tmp/lmstudio.dmg',
      'hdiutil attach /tmp/lmstudio.dmg -mountpoint /tmp/lm-studio-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/lm-studio-mount/LM Studio.app" {{prefix}}/LM Studio.app 2>/dev/null || \\',
      '  find /tmp/lm-studio-mount -maxdepth 1 -name "*.app" -exec cp -R {} {{prefix}}/ \\;',
      'hdiutil detach /tmp/lm-studio-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../LM Studio.app/Contents/MacOS/LM Studio" {{prefix}}/bin/lm-studio',
    ],
  },
}
