import type { Recipe } from '../../scripts/recipe-types'

// Desktop app — installs natively from pantry's registry into /Applications
// (see zig/src/install/native_apps.zig). No Homebrew.
//
// Linear's old download host (desktop.linear.app) was retired (NXDOMAIN), which
// is why its build had been failing and it never published. The current host is
// releases.linear.app/Linear-<version>-universal.dmg. Linear has no GitHub feed,
// but `releases.linear.app/mac` always serves the latest dmg and exposes the
// version in its Content-Disposition filename — so a `custom` versionSource lets
// the daily updater auto-republish new versions.
export const recipe: Recipe = {
  domain: 'linear.app',
  name: 'Linear',
  description: 'A streamlined issue tracking and project management tool.',
  homepage: 'https://linear.app',
  programs: ['linear'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  versionSource: {
    type: 'custom',
    // The latest-dmg endpoint returns `Content-Disposition: attachment;
    // filename="Linear-<version>-universal.dmg"` — parse the version from it.
    fetch: async (): Promise<string[]> => {
      const res = await fetch('https://releases.linear.app/mac', { method: 'HEAD', redirect: 'follow' })
      const cd = res.headers.get('content-disposition') || ''
      const m = cd.match(/Linear-([\d.]+)-universal\.dmg/i)
      return m ? [m[1]] : []
    },
  },
  distributable: null,

  build: {
    script: [
      'curl -fSL -L "https://releases.linear.app/Linear-{{version}}-universal.dmg" -o /tmp/linear.dmg',
      'hdiutil attach /tmp/linear.dmg -mountpoint /tmp/linear-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/linear-mount/Linear.app" {{prefix}}/Linear.app',
      'hdiutil detach /tmp/linear-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Linear.app/Contents/MacOS/Linear" {{prefix}}/bin/linear',
    ],
  },
}
