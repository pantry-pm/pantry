import type { Recipe } from '../../../scripts/recipe-types'
import { fetchClaudeReleases } from '../props/claude.ai/releases'

export const recipe: Recipe = {
  domain: 'claude.ai',
  name: 'Claude Desktop',
  description: 'Anthropic desktop app with Claude Code, chat and Cowork.',
  homepage: 'https://claude.com/download',
  // Claude Code's terminal executable belongs to anthropic.com/claude-code.
  programs: [],
  platforms: ['darwin/aarch64'],
  versionSource: { type: 'custom', fetch: async () => (await fetchClaudeReleases()).map(release => release.version) },
  distributable: null,
  propsDir: '../props/claude.ai',
  build: {
    script: [
      'URL="$(bun "{{srcroot}}/props/releases.ts" "{{version}}")"',
      'curl --proto "=https" --tlsv1.2 -fSL --retry 3 "$URL" -o claude.zip',
      'mkdir claude-unpacked && unzip -qo claude.zip -d claude-unpacked',
      'test -d claude-unpacked/Claude.app',
      'mkdir -p "{{prefix}}" && mv claude-unpacked/Claude.app "{{prefix}}/Claude.app"',
      'bun "{{srcroot}}/props/verify.ts" "{{prefix}}/Claude.app" "{{version}}"',
    ],
    // Rpath rewriting would invalidate Anthropic's signed and notarized bundle.
    skip: ['fix-machos'],
  },
  test: { required: true, script: ['bun "{{srcroot}}/props/verify.ts" "{{prefix}}/Claude.app" "{{version}}"'] },
}
