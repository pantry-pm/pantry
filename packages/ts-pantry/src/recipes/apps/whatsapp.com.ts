import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'whatsapp.com',
  name: 'WhatsApp',
  description: 'A messaging app for simple, reliable, and private communication.',
  homepage: 'https://whatsapp.com',
  programs: ['whatsapp'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],
  // Resolve the version from WhatsApp's own official download (no Homebrew): the
  // stable rolling URL redirects to a CDN filename WhatsApp-<version>.zip. The
  // build downloads that same rolling URL below.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const res = await fetch('https://web.whatsapp.com/desktop/mac_native/release/?extension=zip', { method: 'HEAD', redirect: 'follow' })
      const m = res.url.match(/WhatsApp-([\d.]+)\.zip/i)
      return m ? [m[1]] : []
    },
  },

  build: {
    script: [
      '# WhatsApp downloads as ZIP from the official stable rolling endpoint',
      'curl -fSL -L --retry 3 "https://web.whatsapp.com/desktop/mac_native/release/?extension=zip&configuration=Release" -o /tmp/whatsapp.zip',
      'cd /tmp && unzip -qo whatsapp.zip',
      'mkdir -p "{{prefix}}"',
      'find /tmp -maxdepth 1 -name "WhatsApp.app" -exec mv {} "{{prefix}}/WhatsApp.app" \\;',
      'mkdir -p "{{prefix}}/bin"',
      'ln -sf "../WhatsApp.app/Contents/MacOS/WhatsApp" "{{prefix}}/bin/whatsapp"',
    ],
  },
}
