import type { Recipe } from '../../scripts/recipe-types'

// Desktop app — installs natively from pantry's registry into /Applications
// (see zig/src/install/native_apps.zig). No Homebrew (Dia isn't a cask).
//
// Dia ships a versioned image: Dia-<version>-<build>.dmg/.zip (e.g.
// Dia-1.36.0-82312). The release host exposes no JSON version index, BUT the
// `Dia-latest.dmg` alias always serves the current release and reveals the
// version in its Content-Disposition filename — exactly like Linear. So a
// `custom` versionSource auto-resolves the latest version and the daily updater
// republishes new releases automatically (no manual bump).
//
// The build downloads the always-current `Dia-latest.dmg`, so we never have to
// thread the opaque build number through the URL.
//
// NOTE: the Dia image is ~710MB — publishing relies on the presigned-PUT upload
// path in upload-to-s3.ts (a single in-memory PutObject hangs on files this big).
export const recipe: Recipe = {
  domain: 'diabrowser.com',
  name: 'Dia',
  description: 'An AI-native web browser by The Browser Company.',
  homepage: 'https://www.diabrowser.com',
  programs: [],
  platforms: ['darwin/aarch64'],
  // Auto-update: the latest-dmg alias returns `Content-Disposition: attachment;
  // filename=Dia-<version>-<build>.dmg` — parse the marketing version from it.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const res = await fetch('https://releases.diabrowser.com/release/Dia-latest.dmg', {
        method: 'HEAD',
        redirect: 'follow',
      })
      const cd = res.headers.get('content-disposition') || ''
      const m = cd.match(/Dia-([\d.]+)-\d+\.dmg/i)
      return m ? [m[1]] : []
    },
  },
  distributable: null,

  build: {
    // hdiutil → this recipe builds on the macOS runner.
    script: [
      'curl -fSL -L "https://releases.diabrowser.com/release/Dia-latest.dmg" -o /tmp/dia.dmg',
      'hdiutil attach /tmp/dia.dmg -mountpoint /tmp/dia-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      'src_app="$(find /tmp/dia-mount -maxdepth 1 -name "Dia.app" | head -1)" && cp -R "$src_app" {{prefix}}/Dia.app',
      'hdiutil detach /tmp/dia-mount -quiet || true',
      'rm -rf /tmp/dia.dmg',
    ],
  },
}
