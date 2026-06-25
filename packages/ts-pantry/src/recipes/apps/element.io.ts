import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'element.io',
  name: 'Element',
  description: 'A decentralized, encrypted messaging and collaboration client built on Matrix.',
  homepage: 'https://element.io',
  programs: ['element'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],
  // Resolve the version from Element's own official package server (no Homebrew;
  // the GitHub releases ship only signatures, not a macOS binary). The build
  // downloads the matching universal dmg from the same server.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const res = await fetch('https://packages.element.io/desktop/update/macos/releases.json')
      const data = await res.json() as any
      return data?.currentRelease ? [String(data.currentRelease)] : []
    },
  },

  build: {
    script: [
      'curl -fSL -L --retry 3 "https://packages.element.io/desktop/install/macos/Element-{{version}}-universal.dmg" -o /tmp/element.dmg',
      'hdiutil attach /tmp/element.dmg -mountpoint /tmp/element-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/element-mount/Element.app" {{prefix}}/Element.app',
      'hdiutil detach /tmp/element-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Element.app/Contents/MacOS/Element" {{prefix}}/bin/element',
    ],
  },
}
