import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'cursor.com',
  name: 'Cursor',
  description: 'An AI-first code editor built for pair programming.',
  homepage: 'https://cursor.com',
  programs: ['cursor'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],
  // Without a versionSource the desktop updater can't resolve a "latest" and
  // skips the package entirely (even with --force), which is why this stayed a
  // stub. Track the Homebrew cask's marketing version.
  versionSource: {
    type: 'homebrew-cask',
    cask: 'cursor',
    versionField: 'marketing',
  },

  build: {
    script: [
      'set -e',
      'UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"',
      '# Resolve the real, signed download URL from Cursor\'s official API (the',
      '# downloads.cursor.com "latest" path 403s behind Cloudflare, and brew may',
      '# be unavailable on the builder). Falls back to brew cask.',
      'case "$(uname -m)" in arm64|aarch64) CPLAT="darwin-arm64" ;; *) CPLAT="darwin-x64" ;; esac',
      '# Parse the JSON with sed (bun/jq are not guaranteed in the build sandbox).',
      'URL=$(curl -fsSL -H "User-Agent: $UA" "https://www.cursor.com/api/download?platform=$CPLAT&releaseTrack=stable" | sed -nE \'s/.*"downloadUrl":"([^"]+)".*/\\1/p\' | head -1)',
      'if [ -z "$URL" ]; then',
      '  URL=$(curl -fsSL "https://formulae.brew.sh/api/cask/cursor.json" | sed -nE \'s/.*"url":"([^"]+\\.(dmg|zip))".*/\\1/p\' | head -1)',
      'fi',
      '[ -n "$URL" ] || { echo "ERROR: could not resolve a Cursor download URL"; exit 1; }',
      'echo "Downloading Cursor from $URL"',
      'curl -fSL -L --retry 3 -H "User-Agent: $UA" "$URL" -o /tmp/cursor-download',
      'cd /tmp',
      'mkdir -p {{prefix}}',
      '# Copy Cursor.app straight to the prefix from its known location. Decide by',
      '# URL extension, not `file` magic (modern compressed DMGs read as "zlib',
      '# compressed data"), and avoid `find /tmp` (on macOS /tmp is a symlink, so',
      '# `find /tmp -maxdepth 1` lists nothing).',
      'case "$URL" in',
      '  *.zip)',
      '    mv cursor-download cursor.zip && unzip -qo cursor.zip',
      '    cp -R /private/tmp/Cursor.app "{{prefix}}/Cursor.app" ;;',
      '  *)',
      '    mv cursor-download cursor.dmg',
      '    hdiutil attach cursor.dmg -mountpoint /tmp/cursor-mount -nobrowse -noverify -quiet',
      '    cp -R /tmp/cursor-mount/Cursor.app "{{prefix}}/Cursor.app"',
      '    hdiutil detach /tmp/cursor-mount -quiet || true ;;',
      'esac',
      '# Fail loudly instead of publishing a stub artifact with only a dangling bin symlink.',
      '[ -d "{{prefix}}/Cursor.app" ] || { echo "ERROR: Cursor.app was not produced"; exit 1; }',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Cursor.app/Contents/Resources/app/bin/cursor" {{prefix}}/bin/cursor',
    ],
  },
}
