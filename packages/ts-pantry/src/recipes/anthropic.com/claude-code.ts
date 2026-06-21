import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'anthropic.com/claude-code',
  name: 'claude-code',
  description: 'Claude Code — Anthropic\'s agentic coding CLI that lives in your terminal.',
  homepage: 'https://github.com/anthropics/claude-code',
  github: 'https://github.com/anthropics/claude-code',
  programs: ['claude'],
  // Upstream publishes a standalone, native `claude` binary per platform as a
  // separate npm package (`@anthropic-ai/claude-code-<platform>-<arch>`). It is
  // fully self-contained (no Node runtime needed), so we fetch that package's
  // tarball directly and install the bare binary — no nodejs.org dependency.
  //
  // No `platforms` field on purpose: like openai.com/codex, each platform's
  // binary is built natively on its own runner and uploaded under that single
  // platform key (build-and-upload registers the artifact under the build
  // host's platform when the recipe declares none). The case statement below
  // documents the supported targets (darwin & linux, arm64 & x86-64).
  // The npm wrapper (`@anthropic-ai/claude-code`) has no usable GitHub release
  // feed for version tracking, so resolve the latest version from the npm
  // registry's dist-tags. The daily updater calls this `fetch()` (newest-first).
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const res = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code/latest')
      if (!res.ok)
        return []
      const json = await res.json() as { version?: string }
      return json.version ? [json.version] : []
    },
  },
  distributable: null,

  build: {
    script: [
      'VERSION={{version}}',
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) SLUG="darwin-arm64" ;;',
      '  darwin+x86-64)  SLUG="darwin-x64"   ;;',
      '  linux+x86-64)   SLUG="linux-x64"    ;;',
      '  linux+aarch64)  SLUG="linux-arm64"  ;;',
      '  *) echo "claude-code: no prebuilt binary for {{hw.platform}}/{{hw.arch}}" >&2; exit 1 ;;',
      'esac',
      '',
      // Each per-platform package ships a single self-contained binary at
      // `package/claude`. The tarball lives at the standard npm registry path.
      'URL="https://registry.npmjs.org/@anthropic-ai/claude-code-${SLUG}/-/claude-code-${SLUG}-${VERSION}.tgz"',
      'curl -Lfo claude-code.tgz "$URL"',
      'tar xzf claude-code.tgz',
      '',
      'install -Dm755 package/claude {{prefix}}/bin/claude',
    ],
  },
  test: {
    script: [
      'claude --version',
      'test "$(claude --version)" = "{{version}} (Claude Code)"',
    ],
  },
}
