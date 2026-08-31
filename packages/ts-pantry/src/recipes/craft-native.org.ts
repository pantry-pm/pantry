import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'craft-native.org',
  name: 'craft',
  description: 'Build desktop apps with web languages, powered by Zig',
  homepage: 'https://craft-native.org',
  github: 'https://github.com/craft-native/craft',
  programs: ['craft'],
  // Many craft GitHub releases (v0.0.16 and everything older) ship NO binary
  // assets at all — they predate upstream's binary publishing. The scheduled
  // version-fetcher merges discovered versions into the package catalog
  // additively and never prunes, so a plain `github-releases` source keeps
  // re-adding releases Pantry cannot install (`pantry install
  // craft-native.org@0.0.16` fails: the registry only serves binaries built
  // from asset-bearing releases). Only surface releases that publish the full
  // prebuilt set this recipe downloads below.
  versionSource: {
    type: 'custom',
    async fetch() {
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'pantry-version-fetcher',
      }
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
      if (token)
        headers.Authorization = `token ${token}`
      const resp = await fetch('https://api.github.com/repos/craft-native/craft/releases?per_page=50', {
        headers,
        signal: AbortSignal.timeout(30000),
      })
      // Throw rather than return []: an empty list means "upstream published
      // nothing installable", and the sweep records that as a clean check. A
      // 403 is not that, and reporting it as that is how a rate-limited run
      // comes out looking identical to a healthy one.
      if (!resp.ok)
        throw new Error(`craft-native/craft: GitHub API returned ${resp.status}`)
      const releases = await resp.json() as Array<{
        tag_name: string
        prerelease: boolean
        draft: boolean
        assets: Array<{ name: string }>
      }>
      const versions: string[] = []
      for (const release of releases) {
        if (release.draft || release.prerelease)
          continue
        const match = release.tag_name.match(/^v(.+)$/)
        if (!match)
          continue
        // A version is installable only when its release carries every
        // prebuilt binary the platform map below downloads.
        const required = ['craft-darwin-arm64.zip', 'craft-darwin-x64.zip', 'craft-linux-x64.zip']
        const assets = new Set(release.assets.map(asset => asset.name))
        if (!required.every(asset => assets.has(asset)))
          continue
        versions.push(match[1])
      }
      return versions
    },
  },

  // craft ships official prebuilt per-platform binaries on its GitHub releases
  // (craft-{os}-{arch}.zip). This is a zig-style download recipe: case on
  // {{hw.platform}}/{{hw.arch}}, curl the official asset, and install `craft`.
  // Current releases (v0.0.23+) ship darwin-arm64, darwin-x64, and linux-x64
  // assets; a linux-arm64 asset existed only for v0.0.19/v0.0.20, and since
  // every catalog version must build on every listed platform, linux/aarch64
  // stays omitted. v0.0.37 also ships windows-x64, but Pantry's CLI build
  // pipeline targets unix only (windows platforms appear on desktop-app
  // recipes), so windows stays out as well.
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'linux/x86-64'],

  build: {
    script: [
      'VERSION={{version}}',
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) ASSET="craft-darwin-arm64.zip" ;;',
      '  darwin+x86-64)  ASSET="craft-darwin-x64.zip"   ;;',
      '  linux+x86-64)   ASSET="craft-linux-x64.zip"    ;;',
      '  *) echo "unsupported platform: {{hw.platform}}+{{hw.arch}}" >&2; exit 1 ;;',
      'esac',
      '',
      'URL="https://github.com/craft-native/craft/releases/download/v${VERSION}/${ASSET}"',
      'curl -Lfo craft.zip "$URL"',
      'unzip -o craft.zip',
      '',
      'install -Dm755 craft {{prefix}}/bin/craft',
    ],
  },
}
