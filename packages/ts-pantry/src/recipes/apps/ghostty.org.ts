import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'ghostty.org',
  name: 'Ghostty',
  description: 'A fast, feature-rich, and cross-platform terminal emulator.',
  homepage: 'https://ghostty.org',
  github: 'https://github.com/ghostty-org/ghostty',
  programs: ['ghostty'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  // Ghostty's GitHub releases are published as pre-releases, so the API's
  // `releases/latest` endpoint 404s and the github-releases source resolved to
  // null — the desktop updater then skipped the package and it went stale (same
  // failure mode raycast.com had). Track the Homebrew cask's marketing version
  // instead (kept current by Homebrew's livecheck/autobump); the .dmg download
  // URL is versioned by {{version}}, which the cask version feeds.
  versionSource: {
    type: 'homebrew-cask',
    cask: 'ghostty',
    versionField: 'marketing',
  },

  build: {
    script: [
      'curl -fSL "https://release.files.ghostty.org/{{version}}/Ghostty.dmg" -o /tmp/ghostty.dmg',
      'hdiutil attach /tmp/ghostty.dmg -mountpoint /tmp/ghostty-mount -nobrowse -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/ghostty-mount/Ghostty.app" {{prefix}}/Ghostty.app',
      'hdiutil detach /tmp/ghostty-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Ghostty.app/Contents/MacOS/ghostty" {{prefix}}/bin/ghostty',
    ],
  },
}
