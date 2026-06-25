import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'ziglang.org',
  name: 'zig',
  description: 'General-purpose programming language and toolchain for maintaining robust, optimal, and reusable software.',
  homepage: 'https://ziglang.org/',
  github: 'https://github.com/ziglang/zig',
  programs: ['zig'],
  // Zig's dev/master builds (e.g. `0.17.0-dev.956+2dca73595`) are NOT published
  // as GitHub releases — they only appear in `ziglang.org/download/index.json`
  // under the `master` key. A `github-releases` source therefore never sees a
  // new nightly and the catalog freezes on whatever dev build was last hand-
  // committed (it had stalled at `0.17.0-dev.131`). Pull straight from the same
  // index the official installer uses so the scheduled version-fetcher tracks
  // the current master (plus every tagged stable) within one run.
  versionSource: {
    type: 'custom',
    async fetch() {
      const resp = await fetch('https://ziglang.org/download/index.json', {
        headers: { 'User-Agent': 'pantry-version-fetcher' },
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok)
        return []
      const index = await resp.json() as Record<string, { version?: string }>
      const versions: string[] = []
      // Current master dev build first (newest, e.g. `0.17.0-dev.956+2dca73595`).
      if (index.master?.version)
        versions.push(index.master.version)
      // Then every tagged stable release the index lists (e.g. `0.16.0`, `0.15.2`).
      for (const key of Object.keys(index)) {
        if (key === 'master')
          continue
        if (/^\d+\.\d+\.\d+$/.test(key))
          versions.push(key)
      }
      return versions
    },
  },

  build: {
    script: [
      'VERSION={{version}}',
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) PLATFORM="aarch64-macos" ;;',
      '  darwin+x86-64)  PLATFORM="x86_64-macos"  ;;',
      '  linux+aarch64)  PLATFORM="aarch64-linux" ;;',
      '  linux+x86-64)   PLATFORM="x86_64-linux"  ;;',
      'esac',
      '',
      '# Dev versions (sanitized: + replaced with _ for S3) need original version for download',
      '# Restore + from _ in dev versions for the download URL',
      'DOWNLOAD_VERSION="$VERSION"',
      'if echo "$VERSION" | grep -q "\\-dev"; then',
      '  DOWNLOAD_VERSION=$(echo "$VERSION" | sed "s/_/+/")',
      '  URL="https://ziglang.org/builds/zig-${PLATFORM}-${DOWNLOAD_VERSION}.tar.xz"',
      'else',
      '  URL="https://ziglang.org/download/${VERSION}/zig-${PLATFORM}-${VERSION}.tar.xz"',
      'fi',
      '',
      'curl -Lfo zig.tar.xz "$URL"',
      'tar Jxf zig.tar.xz',
      '',
      'install -Dm755 "zig-${PLATFORM}-${DOWNLOAD_VERSION}/zig" {{prefix}}/bin/zig',
      'cp -a "zig-${PLATFORM}-${DOWNLOAD_VERSION}/lib" {{prefix}}',
    ],
  },
}
