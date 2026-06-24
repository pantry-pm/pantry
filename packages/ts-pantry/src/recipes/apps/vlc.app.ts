import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'vlc.app',
  name: 'VLC',
  description: 'A free and open-source cross-platform multimedia player.',
  homepage: 'https://videolan.org',
  programs: ['vlc'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],
  // Without a versionSource the desktop updater can't resolve a "latest" and
  // skips the package entirely (even with --force), so it silently went stale.
  // Track the Homebrew cask's marketing version (the same one upstream ships).
  versionSource: {
    type: 'homebrew-cask',
    cask: 'vlc',
    versionField: 'marketing',
  },

  build: {
    script: [
      'if test {{hw.arch}} = "aarch64"; then ARCH="arm64"; else ARCH="intel64"; fi',
      'curl -fSL "https://get.videolan.org/vlc/{{version}}/macosx/vlc-{{version}}-${ARCH}.dmg" -o /tmp/vlc.dmg',
      'hdiutil attach /tmp/vlc.dmg -mountpoint /tmp/vlc-mount -nobrowse -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/vlc-mount/VLC.app" {{prefix}}/VLC.app',
      'hdiutil detach /tmp/vlc-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../VLC.app/Contents/MacOS/VLC" {{prefix}}/bin/vlc',
    ],
  },
}
