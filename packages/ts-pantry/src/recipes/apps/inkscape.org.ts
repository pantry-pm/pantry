import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'inkscape.org',
  name: 'Inkscape',
  description: 'A professional vector graphics editor.',
  homepage: 'https://inkscape.org',
  programs: ['inkscape'],
  // Inkscape ships separate per-arch dmgs (no universal). The pipeline builds
  // once and registers under both darwin keys, so we ship the Apple-Silicon dmg.
  platforms: ['darwin/aarch64'],
  // Resolve the version from inkscape.org's own release page (no Homebrew): the
  // /release/ URL redirects to /release/inkscape-<version>/.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const res = await fetch('https://inkscape.org/release/', { redirect: 'follow' })
      const m = res.url.match(/inkscape-([\d.]+)/i)
      return m ? [m[1]] : []
    },
  },

  build: {
    script: [
      'curl -fSL -L --retry 3 "https://media.inkscape.org/dl/resources/file/Inkscape-{{version}}_arm64.dmg" -o /tmp/inkscape.dmg',
      'hdiutil attach /tmp/inkscape.dmg -mountpoint /tmp/inkscape-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/inkscape-mount/Inkscape.app" {{prefix}}/Inkscape.app 2>/dev/null || \\',
      '  find /tmp/inkscape-mount -maxdepth 1 -name "*.app" -exec cp -R {} {{prefix}}/ \\;',
      'hdiutil detach /tmp/inkscape-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Inkscape.app/Contents/MacOS/inkscape" {{prefix}}/bin/inkscape',
    ],
  },
}
