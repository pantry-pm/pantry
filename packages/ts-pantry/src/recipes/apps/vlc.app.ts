import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'vlc.app',
  name: 'VLC',
  description: 'A free and open-source cross-platform multimedia player.',
  homepage: 'https://videolan.org',
  programs: ['vlc'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],
  // Resolve the version from VideoLAN's own official "last" directory listing
  // (no Homebrew). The build downloads the UNIVERSAL dmg so a single artifact is
  // native on both Apple Silicon and Intel (the pipeline builds once on the
  // Linux runner and registers it under both darwin platforms).
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const html = await (await fetch('https://get.videolan.org/vlc/last/macosx/')).text()
      const m = html.match(/vlc-([\d.]+)-universal\.dmg/)
      return m ? [m[1]] : []
    },
  },

  build: {
    script: [
      'curl -fSL -L --retry 3 "https://get.videolan.org/vlc/{{version}}/macosx/vlc-{{version}}-universal.dmg" -o /tmp/vlc.dmg',
      'hdiutil attach /tmp/vlc.dmg -mountpoint /tmp/vlc-mount -nobrowse -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/vlc-mount/VLC.app" {{prefix}}/VLC.app',
      'hdiutil detach /tmp/vlc-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../VLC.app/Contents/MacOS/VLC" {{prefix}}/bin/vlc',
    ],
  },
}
