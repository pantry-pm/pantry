import type { Recipe } from '../../../scripts/recipe-types'
import { redirectVersionSource } from '../../../scripts/desktop-version-sources'

export const recipe: Recipe = {
  domain: 'warp.dev',
  name: 'Warp',
  description: 'A modern, Rust-based terminal with AI built in.',
  homepage: 'https://warp.dev',
  programs: ['warp'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],

  versionSource: redirectVersionSource('https://app.warp.dev/download?package=dmg', /\/v([^/]+)\/Warp\.dmg$/),

  build: {
    script: [
      'curl -fSL "https://releases.warp.dev/stable/v{{version}}/Warp.dmg" -L -o /tmp/warp.dmg',
      'hdiutil attach /tmp/warp.dmg -mountpoint /tmp/warp-mount -nobrowse -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/warp-mount/Warp.app" {{prefix}}/Warp.app',
      'hdiutil detach /tmp/warp-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Warp.app/Contents/MacOS/stable" {{prefix}}/bin/warp',
    ],
  },
}
