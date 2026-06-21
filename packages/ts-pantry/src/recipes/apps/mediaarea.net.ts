import type { Recipe } from '../../scripts/recipe-types'

// Desktop app — installs natively from pantry's registry into /Applications
// (see zig/src/install/native_apps.zig). No Homebrew.
//
// MediaInfo ships a macOS .dmg per version. Versions track the upstream GitHub
// repo MediaArea/MediaInfo, whose release/tag is `v26.05`, so the daily updater
// auto-republishes new versions via github-releases. Build is macOS-only (mounts
// the dmg with hdiutil).
export const recipe: Recipe = {
  domain: 'mediaarea.net',
  name: 'MediaInfo',
  description: 'Display technical and tag data for video and audio files.',
  homepage: 'https://mediaarea.net/en/MediaInfo',
  github: 'https://github.com/MediaArea/MediaInfo',
  programs: [],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  versionSource: {
    type: 'github-releases',
    repo: 'MediaArea/MediaInfo',
    tagPattern: /^v(.+)$/,
  },
  distributable: null,

  build: {
    script: [
      'curl -fSL -L "https://mediaarea.net/download/binary/mediainfo-gui/{{version}}/MediaInfo_GUI_{{version}}_Mac.dmg" -o /tmp/mediainfo.dmg',
      'hdiutil attach /tmp/mediainfo.dmg -mountpoint /tmp/mediainfo-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      // Copy the .app from the mounted image (name is just "MediaInfo.app").
      'src_app="$(find /tmp/mediainfo-mount -maxdepth 2 -name "MediaInfo.app" | head -1)" && cp -R "$src_app" {{prefix}}/MediaInfo.app',
      'hdiutil detach /tmp/mediainfo-mount -quiet || true',
    ],
  },
}
