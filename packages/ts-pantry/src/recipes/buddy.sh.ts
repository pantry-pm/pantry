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
  versionSource: {
    type: 'github-releases',
    repo: 'stacksjs/buddy',
    // Tags are `v0.11.1`; the `v` is matched but not captured, so the version
    // stays semver.
    tagPattern: /^v(.+)$/,
    stable: true,
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
