import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'zed.dev',
  name: 'Zed',
  description: 'A high-performance, multiplayer code editor.',
  homepage: 'https://zed.dev',
  github: 'https://github.com/zed-industries/zed',
  programs: ['zed'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],
  versionSource: {
    type: 'github-releases',
    repo: 'zed-industries/zed',
    tagPattern: /^v(.+)$/,
  },

  build: {
    script: [
      'if test {{hw.arch}} = "aarch64"; then ARCH="aarch64"; else ARCH="x86_64"; fi',
      'curl -fSL "https://github.com/zed-industries/zed/releases/download/v{{version}}/Zed-${ARCH}.dmg" -o /tmp/zed-{{version}}.dmg',
      'hdiutil attach /tmp/zed-{{version}}.dmg -mountpoint /tmp/zed-mount -nobrowse -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/zed-mount/Zed.app" {{prefix}}/Zed.app',
      'hdiutil detach /tmp/zed-mount -quiet || true',
      'rm -f /tmp/zed-{{version}}.dmg',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Zed.app/Contents/MacOS/cli" {{prefix}}/bin/zed',
    ],
  },
}
