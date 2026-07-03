/**
 * **Codex** - OpenAI's Codex desktop app — a command center for the Codex coding agent.
 *
 * @domain `codex.openai.com`
 * @programs (none — GUI app; the `codex` CLI is the separate `openai.com/codex` package)
 * @version `26.616.51431` (1 version available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install codex.openai.com`
 * @homepage https://developers.openai.com/codex/app
 */
export const codexopenaicomPackage = {
  name: 'Codex' as const,
  domain: 'codex.openai.com' as const,
  description: "OpenAI's Codex desktop app — a command center for the Codex coding agent." as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://developers.openai.com/codex/app' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install codex.openai.com' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '26.623.101652',
    '26.623.81905',
    '26.623.70822',
    '26.623.61825',
    '26.623.42026',
    '26.623.41415',
    '26.623.31921',
    '26.616.51431',
  ] as const,
  aliases: [] as const,
}
export type CodexopenaicomPackage = typeof codexopenaicomPackage
