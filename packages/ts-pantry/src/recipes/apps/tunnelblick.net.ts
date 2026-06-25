import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'tunnelblick.net',
  name: 'Tunnelblick',
  description: 'A free, open-source graphic user interface for OpenVPN on macOS.',
  homepage: 'https://tunnelblick.net',
  programs: ['tunnelblick'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  github: 'https://github.com/Tunnelblick/Tunnelblick',
  // Track Tunnelblick's own GitHub releases (no Homebrew). `releases/latest`
  // excludes the separate beta releases, giving the current stable.
  versionSource: {
    type: 'github-releases',
    repo: 'Tunnelblick/Tunnelblick',
    tagPattern: /^v(.+)$/,
  },

  build: {
    script: [
      // The dmg filename carries a build number (Tunnelblick_<ver>_build_<n>.dmg)
      // that isn't derivable from the version, so resolve the exact asset URL
      // from the GitHub release for this tag. No Homebrew, no brew binary.
      'API="https://api.github.com/repos/Tunnelblick/Tunnelblick/releases/tags/v{{version}}"',
      'DMG_URL=$(curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} "$API" | grep -oE "https://[^\\"]+/Tunnelblick_[^\\"]+\\.dmg" | head -1)',
      '[ -n "$DMG_URL" ] || { echo "could not resolve Tunnelblick dmg asset for v{{version}}"; exit 1; }',
      'curl -fSL -L --retry 3 "$DMG_URL" -o /tmp/tunnelblick.dmg',
      'hdiutil attach /tmp/tunnelblick.dmg -mountpoint /tmp/tunnelblick-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/tunnelblick-mount/Tunnelblick.app" {{prefix}}/Tunnelblick.app 2>/dev/null || \\',
      '  find /tmp/tunnelblick-mount -maxdepth 1 -name "*.app" -exec cp -R {} {{prefix}}/ \\;',
      'hdiutil detach /tmp/tunnelblick-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Tunnelblick.app/Contents/MacOS/Tunnelblick" {{prefix}}/bin/tunnelblick',
    ],
  },
}
