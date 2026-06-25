import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'libreoffice.org',
  name: 'LibreOffice',
  description: 'A free and powerful office suite.',
  homepage: 'https://libreoffice.org',
  programs: ['libreoffice'],
  // LibreOffice ships separate per-arch dmgs (no universal). The pipeline builds
  // once and registers under both darwin keys, so we ship the Apple-Silicon dmg.
  platforms: ['darwin/aarch64'],
  // Resolve the version from The Document Foundation's own stable directory
  // index (no Homebrew) — take the highest version present. The build downloads
  // the matching aarch64 dmg below.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const html = await (await fetch('https://download.documentfoundation.org/libreoffice/stable/')).text()
      const vs = [...html.matchAll(/href="(\d+\.\d+\.\d+)\//g)].map(m => m[1])
      vs.sort((a, b) => {
        const pa = a.split('.').map(Number)
        const pb = b.split('.').map(Number)
        for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pb[i] - pa[i] }
        return 0
      })
      return vs.length ? [vs[0]] : []
    },
  },

  build: {
    script: [
      'curl -fSL -L --retry 3 "https://download.documentfoundation.org/libreoffice/stable/{{version}}/mac/aarch64/LibreOffice_{{version}}_MacOS_aarch64.dmg" -o /tmp/libreoffice.dmg',
      'hdiutil attach /tmp/libreoffice.dmg -mountpoint /tmp/libreoffice-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/libreoffice-mount/LibreOffice.app" {{prefix}}/LibreOffice.app 2>/dev/null || \\',
      '  find /tmp/libreoffice-mount -maxdepth 1 -name "*.app" -exec cp -R {} {{prefix}}/ \\;',
      'hdiutil detach /tmp/libreoffice-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../LibreOffice.app/Contents/MacOS/soffice" {{prefix}}/bin/libreoffice',
    ],
  },
}
