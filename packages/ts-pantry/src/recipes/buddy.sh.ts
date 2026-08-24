import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'buddy.sh',
  name: 'buddy',
  description: 'AI code review and dependency updates in one teammate — reviews pull requests and local changes, gates merges, repairs CI, and keeps dependencies current',
  homepage: 'https://buddy.sh',
  github: 'https://github.com/stacksjs/buddy',
  programs: ['buddy'],
  // Windows binaries are published too, but the registry only builds these four.
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'linux/aarch64', 'linux/x86-64'],
  // Not `github-releases`: a tag existing does not mean it is installable here.
  //
  // Buddy's release workflow prunes the platform zips from older releases (they
  // are ~150 MB each), keeping only the newest few. Discovering versions from
  // tags therefore advertised 50 of them while exactly one still had assets, and
  // the automated metadata refresh wrote that whole list back into the catalog —
  // so every build but the newest 404'd.
  //
  // Asking which releases still carry the asset keeps the catalog honest no
  // matter how often the metadata job re-runs, and it self-corrects as the
  // retention window moves.
  versionSource: {
    type: 'custom',
    fetch: async () => {
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'pantry',
      }
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
      if (token)
        headers.Authorization = `Bearer ${token}`

      const response = await fetch(
        'https://api.github.com/repos/stacksjs/buddy/releases?per_page=100',
        { headers },
      )
      if (!response.ok)
        throw new Error(`GitHub releases lookup failed: ${response.status}`)

      const releases = await response.json() as Array<{
        tag_name: string
        draft: boolean
        prerelease: boolean
        assets: Array<{ name: string }>
      }>

      // One asset name stands in for the set: the release workflow uploads all
      // platforms together or not at all.
      const PROBE = 'buddy-darwin-arm64.zip'

      return releases
        .filter(release => !release.draft && !release.prerelease)
        .filter(release => release.assets.some(asset => asset.name === PROBE))
        .map(release => release.tag_name.replace(/^v/, ''))
        .filter(version => /^\d+\.\d+\.\d+/.test(version))
    },
  },
  // Prebuilt download, not a source build: the release workflow publishes a
  // per-platform zip built with `bun build --compile`.
  distributable: null,
  buildDependencies: {
    'curl.se': '*',
    'info-zip.org/unzip': '*',
  },

  build: {
    script: [
      // The asset names use the release workflow's own spelling, which differs
      // from pantry's on both axes: `x86-64` is `x64` upstream, and `aarch64`
      // is `arm64`.
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) ASSET="buddy-darwin-arm64" ;;',
      '  darwin+x86-64)  ASSET="buddy-darwin-x64"   ;;',
      '  linux+aarch64)  ASSET="buddy-linux-arm64"  ;;',
      '  linux+x86-64)   ASSET="buddy-linux-x64"    ;;',
      '  *) echo "unsupported platform: {{hw.platform}}+{{hw.arch}}" >&2; exit 1 ;;',
      'esac',
      '',
      'curl -Lfo buddy.zip "https://github.com/stacksjs/buddy/releases/download/v{{version}}/${ASSET}.zip"',
      // The archive holds a single file named after the platform, so it is
      // renamed on install rather than unpacked to its own name.
      'unzip -qj buddy.zip',
      'install -Dm755 "${ASSET}" "{{prefix}}/bin/buddy"',
    ],
    // A `bun build --compile` binary carries its own runtime and is signed on
    // macOS. Rewriting its load commands or its interpreter breaks it, and it
    // needs neither — nothing outside the binary is linked.
    skip: ['fix-patchelf', 'fix-machos'],
  },

  test: {
    script: [
      'buddy --version | grep "{{version}}"',
    ],
  },
}
