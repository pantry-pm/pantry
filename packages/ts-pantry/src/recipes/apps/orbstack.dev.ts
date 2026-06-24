import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'orbstack.dev',
  name: 'OrbStack',
  description: 'A fast, lightweight Docker and Linux on macOS.',
  homepage: 'https://orbstack.dev',
  programs: ['orbstack'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  // Without a versionSource the desktop updater can't resolve a "latest" and
  // skips the package entirely (even with --force), so it silently went stale.
  // Track the Homebrew cask's marketing version (the same one upstream ships).
  versionSource: {
    type: 'homebrew-cask',
    cask: 'orbstack',
    versionField: 'marketing',
  },

  build: {
    script: [
      // The old unversioned alias (cdn-updates.orbstack.dev/arm64/OrbStack.dmg)
      // now 404s; the stable "latest" endpoint 307-redirects to the current
      // versioned DMG (curl -L follows it). Keep the CDN URL as a fallback.
      'curl -fSL -L --retry 3 -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" "https://orbstack.dev/download/stable/latest/arm64" -o /tmp/orbstack.dmg || curl -fSL -L --retry 3 -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" "https://cdn-updates.orbstack.dev/arm64/OrbStack.dmg" -o /tmp/orbstack.dmg',
      'hdiutil attach /tmp/orbstack.dmg -mountpoint /tmp/orbstack-mount -nobrowse -noverify -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/orbstack-mount/OrbStack.app" {{prefix}}/OrbStack.app',
      'hdiutil detach /tmp/orbstack-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../OrbStack.app/Contents/MacOS/OrbStack" {{prefix}}/bin/orbstack',
    ],
  },
}
