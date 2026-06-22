import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'codex.openai.com',
  name: 'Codex',
  description: "OpenAI's Codex desktop app — a command center for the Codex coding agent.",
  homepage: 'https://developers.openai.com/codex/app',
  // The `codex` CLI ships separately as the `openai.com/codex` package; this
  // recipe installs the GUI app only, so it declares no `programs` — no bin
  // shim, hence no clash with the existing `codex` CLI (and its alias).
  programs: [],
  // OpenAI publishes the desktop app for Apple Silicon only: the Sparkle
  // appcast advertises arm64 with `sparkle:hardwareRequirements = arm64`.
  platforms: ['darwin/aarch64'],
  // Discover new versions from OpenAI's own Sparkle appcast (items are listed
  // newest-first; `shortVersionString` is the user-facing version, e.g.
  // 26.616.51431). Used by check-desktop-updates to bump desktop-versions.json.
  versionSource: {
    type: 'custom',
    fetch: async () => {
      const res = await fetch('https://persistent.oaistatic.com/codex-app-prod/appcast.xml')
      const xml = await res.text()
      return [...xml.matchAll(/<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/g)].map(m => m[1])
    },
  },

  build: {
    script: [
      'set -e',
      // The appcast exposes a per-version, signed ZIP enclosure that contains
      // Codex.app at the archive root (no DMG / hdiutil needed).
      'URL="https://persistent.oaistatic.com/codex-app-prod/Codex-darwin-arm64-{{version}}.zip"',
      'echo "Downloading Codex from $URL"',
      'curl -fSL -L --retry 3 "$URL" -o /tmp/codex-app.zip',
      'rm -rf /tmp/codex-extract && mkdir -p /tmp/codex-extract',
      'cd /tmp/codex-extract && unzip -qo /tmp/codex-app.zip',
      // Glob in the physical CWD; `find /tmp` is unreliable (macOS /tmp symlink).
      'cd "$(pwd -P)"',
      'APP=""; for a in *.app; do [ -d "$a" ] && APP="$a" && break; done',
      '[ -n "$APP" ] || { echo "ERROR: Codex.app was not produced"; exit 1; }',
      'mkdir -p {{prefix}}',
      'mv "$APP" "{{prefix}}/Codex.app"',
      // Fail loudly instead of publishing a stub artifact.
      '[ -d "{{prefix}}/Codex.app" ] || { echo "ERROR: Codex.app missing after move"; exit 1; }',
      'rm -f /tmp/codex-app.zip',
    ],
    // Codex.app is notarized & signed by OpenAI. The default post-build
    // fix-machos pass rewrites Mach-O rpaths, which BREAKS the code signature
    // ("a sealed resource is missing or invalid") and makes Gatekeeper reject
    // the app. Skip it so the signed bundle ships byte-for-byte intact.
    skip: ['fix-machos'],
  },
}
