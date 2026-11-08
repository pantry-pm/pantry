import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'whatsapp.com',
  name: 'WhatsApp',
  description: 'A messaging app for simple, reliable, and private communication.',
  homepage: 'https://whatsapp.com',
  programs: ['whatsapp'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],
  // The CDN filename includes an extra version prefix. Inspect the signed
  // bundle's own marketing version and bind it to the rolling archive validators.
  versionSource: {
    type: 'desktop-bundle',
    url: 'https://web.whatsapp.com/desktop/mac_native/release/?extension=zip&configuration=Release',
    format: 'zip',
    bundle: 'WhatsApp.app',
  },

  build: {
    script: [
      'curl --proto "=https" --tlsv1.2 -fSL --connect-timeout 30 --max-time 600 --retry 2 "https://web.whatsapp.com/desktop/mac_native/release/?extension=zip&configuration=Release" -o "$PWD/whatsapp.zip"',
      'mkdir -p "$PWD/unpacked" && unzip -qo "$PWD/whatsapp.zip" -d "$PWD/unpacked"',
      'test -d "$PWD/unpacked/WhatsApp.app"',
      'mkdir -p "{{prefix}}" && mv "$PWD/unpacked/WhatsApp.app" "{{prefix}}/WhatsApp.app"',
      'mkdir -p "{{prefix}}/bin"',
      'ln -sf "../WhatsApp.app/Contents/MacOS/WhatsApp" "{{prefix}}/bin/whatsapp"',
    ],
  },
}
