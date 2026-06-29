import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'keepassxc.org',
  name: 'KeePassXC',
  description: 'A cross-platform community-driven password manager.',
  homepage: 'https://keepassxc.org',
  programs: ['keepassxc'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],

  build: {
    script: [
      'if test {{hw.arch}} = "aarch64"; then ARCH="arm64"; else ARCH="x86_64"; fi',
      'curl -fSL -L "https://github.com/keepassxreboot/keepassxc/releases/download/{{version}}/KeePassXC-{{version}}-${ARCH}.dmg" -o /tmp/keepassxc.dmg',
      'hdiutil attach /tmp/keepassxc.dmg -mountpoint /tmp/keepassxc-mount -nobrowse -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/keepassxc-mount/KeePassXC.app" {{prefix}}/KeePassXC.app',
      'hdiutil detach /tmp/keepassxc-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../KeePassXC.app/Contents/MacOS/KeePassXC" {{prefix}}/bin/keepassxc',
    ],
  },
}
