/** Claude Desktop includes the graphical Claude Code interface; its CLI is a separate package. */
export const claudeaiPackage = {
  name: 'Claude Desktop' as const,
  domain: 'claude.ai' as const,
  description: 'Anthropic desktop app with Claude Code, chat and Cowork.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://claude.com/download' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install claude-desktop' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '5.11492.0',
    '5.1231.2',
    '5.1231.0',
    '4.23118.1',
    '4.23118.0',
  ] as const,
  aliases: ['claude-desktop', 'claude-code-desktop', 'claude-app'] as const,
}
export type ClaudeaiPackage = typeof claudeaiPackage
