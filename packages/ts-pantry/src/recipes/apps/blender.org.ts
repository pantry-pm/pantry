import type { Recipe } from '../../../scripts/recipe-types'
import { textVersionSource } from '../../../scripts/desktop-version-sources'

export const recipe: Recipe = {
  domain: 'blender.org',
  name: 'Blender',
  description: 'A free and open-source 3D creation suite.',
  homepage: 'https://blender.org',
  programs: ['blender'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],

  versionSource: textVersionSource('https://www.blender.org/download/', /blender-(\d+(?:\.\d+){2})-macos-arm64\.dmg/),

  build: {
    script: [
      'if test {{hw.arch}} = "aarch64"; then ARCH="arm64"; else ARCH="x64"; fi',
      'curl -fSL -L "https://download.blender.org/release/Blender{{version.marketing}}/blender-{{version}}-macos-${ARCH}.dmg" -o /tmp/blender.dmg',
      'hdiutil attach /tmp/blender.dmg -mountpoint /tmp/blender-mount -nobrowse -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/blender-mount/Blender.app" {{prefix}}/Blender.app',
      'hdiutil detach /tmp/blender-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Blender.app/Contents/MacOS/Blender" {{prefix}}/bin/blender',
    ],
  },
}
