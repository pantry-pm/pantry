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
      'URL=$(curl -fsSL -H "User-Agent: $UA" "https://www.cursor.com/api/download?platform=$CPLAT&releaseTrack=stable" | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log(d.downloadUrl||\'\')" 2>/dev/null || true)',
      'if [ -z "$URL" ]; then',
      '  URL=$(brew info --cask --json=v2 cursor 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log(d.casks[0].url)" 2>/dev/null || true)',
      'fi',
      '[ -n "$URL" ] || { echo "ERROR: could not resolve a Cursor download URL"; exit 1; }',
      'echo "Downloading Cursor from $URL"',
      'curl -fSL -L --retry 3 -H "User-Agent: $UA" "$URL" -o /tmp/cursor-download',
      'cd /tmp',
      'if file cursor-download | grep -q "Zip archive"; then',
      '  mv cursor-download cursor.zip && unzip -qo cursor.zip',
      'elif file cursor-download | grep -q "Apple Disk Image\\|VAX COFF"; then',
      '  mv cursor-download cursor.dmg && hdiutil attach cursor.dmg -mountpoint /tmp/cursor-mount -nobrowse -noverify -quiet && cp -R "/tmp/cursor-mount/Cursor.app" /tmp/ && hdiutil detach /tmp/cursor-mount -quiet || true',
      'fi',
      'mkdir -p {{prefix}}',
      'find /tmp -maxdepth 1 -name "Cursor.app" -exec mv {} {{prefix}}/Cursor.app \\;',
      '# Fail loudly instead of publishing a stub artifact with only a dangling bin symlink.',
      '[ -d "{{prefix}}/Cursor.app" ] || { echo "ERROR: Cursor.app was not produced"; exit 1; }',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Cursor.app/Contents/Resources/app/bin/cursor" {{prefix}}/bin/cursor',
    ],
  },
}
