import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'hiddenbar.app',
  name: 'Hidden Bar',
  description: 'A utility to hide menu bar items on macOS.',
  homepage: 'https://github.com/dwarvesf/hidden',
  programs: ['hiddenbar'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  // Needed so the desktop updater can resolve a "latest" (without it the
  // package is skipped, even with --force) — see cursor.com.ts.
  versionSource: {
    type: 'homebrew-cask',
    cask: 'hiddenbar',
    versionField: 'marketing',
  },

  build: {
    script: [
      'set -e',
      'UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"',
      'BREW_URL=$(curl -fsSL "https://formulae.brew.sh/api/cask/hiddenbar.json" | sed -nE \'s/.*"url":"([^"]+\\.zip)".*/\\1/p\' | head -1)',
      'URL="${BREW_URL:-https://github.com/dwarvesf/hidden/releases/latest/download/Hidden.Bar.zip}"',
      'echo "Downloading Hidden Bar from $URL"',
      'curl -fSL -L --retry 3 -H "User-Agent: $UA" "$URL" -o /tmp/hiddenbar.zip',
      'cd /tmp && unzip -qo hiddenbar.zip',
      'mkdir -p {{prefix}}',
      '# The .app name contains a space, so quote the destination — an unquoted',
      '# "mv ... {{prefix}}/Hidden Bar.app" split into two args and produced a',
      '# stub artifact with only a dangling bin symlink.',
      'APP=$(find /tmp -maxdepth 1 -name "Hidden*Bar*.app" | head -1)',
      '[ -n "$APP" ] || { echo "ERROR: Hidden Bar.app was not produced"; exit 1; }',
      'mv "$APP" "{{prefix}}/Hidden Bar.app"',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Hidden Bar.app/Contents/MacOS/Hidden Bar" {{prefix}}/bin/hiddenbar',
    ],
  },
}
