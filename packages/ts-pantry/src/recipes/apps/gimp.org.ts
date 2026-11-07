import type { Recipe } from '../../../scripts/recipe-types'
import { jsonVersionSource } from '../../../scripts/desktop-version-sources'

export const recipe: Recipe = {
  domain: 'gimp.org',
  name: 'GIMP',
  description: 'A free and open-source raster graphics editor.',
  homepage: 'https://gimp.org',
  programs: ['gimp'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],

  versionSource: jsonVersionSource('https://www.gimp.org/gimp_versions.json', data => data.STABLE.filter((release: { macos?: { filename: string }[] }) => release.macos?.some(file => /arm64\.dmg$/.test(file.filename))).map((release: { version: string }) => release.version)),

  build: {
    script: [
      'if test {{hw.arch}} = "aarch64"; then ARCH="arm64"; else ARCH="x86_64"; fi',
      'curl -fSL -L "https://download.gimp.org/gimp/v{{version.marketing}}/macos/gimp-{{version}}-${ARCH}.dmg" -o /tmp/gimp.dmg',
      'hdiutil attach /tmp/gimp.dmg -mountpoint /tmp/gimp-mount -nobrowse -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/gimp-mount/GIMP-{{version.marketing}}.app" {{prefix}}/GIMP.app || cp -R /tmp/gimp-mount/GIMP*.app {{prefix}}/GIMP.app',
      'hdiutil detach /tmp/gimp-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../GIMP.app/Contents/MacOS/gimp" {{prefix}}/bin/gimp',
    ],
  },
}
