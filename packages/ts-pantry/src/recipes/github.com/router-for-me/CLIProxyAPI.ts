import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'github.com/router-for-me/CLIProxyAPI',
  name: 'CLIProxyAPI',
  description: 'CLI Proxy API — use your Gemini CLI, Claude Code, Codex, Kimi, Qwen, iFlow and Grok CLI subscriptions through OpenAI/Gemini/Claude/Codex-compatible API endpoints.',
  homepage: 'https://help.router-for.me/',
  github: 'https://github.com/router-for-me/CLIProxyAPI',
  programs: ['cli-proxy-api'],
  versionSource: {
    type: 'github-releases',
    repo: 'router-for-me/CLIProxyAPI',
  },
  // Prebuilt download: upstream ships official per-platform release archives,
  // so any box can produce the artifact for any target platform (no compile).
  // darwin-x86-64 intentionally omitted — macOS Intel builds are retired.
  distributable: null,

  build: {
    script: [
      'VERSION={{version}}',
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) ASSET="CLIProxyAPI_${VERSION}_darwin_aarch64" ;;',
      '  linux+x86-64)  ASSET="CLIProxyAPI_${VERSION}_linux_amd64"    ;;',
      '  linux+aarch64) ASSET="CLIProxyAPI_${VERSION}_linux_aarch64"  ;;',
      '  *) echo "CLIProxyAPI: no prebuilt binary for {{hw.platform}}/{{hw.arch}}" >&2; exit 1 ;;',
      'esac',
      '',
      // Release tags carry a `v` prefix; the asset names embed the bare version.
      'URL="https://github.com/router-for-me/CLIProxyAPI/releases/download/v${VERSION}/${ASSET}.tar.gz"',
      'curl -Lfo cliproxyapi.tar.gz "$URL"',
      'tar xzf cliproxyapi.tar.gz',
      '',
      '# The archive contains the bare binary plus LICENSE/README/config.example.yaml',
      'install -Dm755 cli-proxy-api {{prefix}}/bin/cli-proxy-api',
      'install -Dm644 config.example.yaml {{prefix}}/share/cliproxyapi/config.example.yaml',
    ],
  },
  test: {
    script: [
      'cli-proxy-api --help',
    ],
  },
}
