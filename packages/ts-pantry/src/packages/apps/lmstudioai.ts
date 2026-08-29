/**
 * **LM Studio** - A desktop app for discovering, downloading, and running local LLMs.
 *
 * @domain `lmstudio.ai`
 * @programs `lm-studio`
 * @version `0.4.23-1` (8 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install lmstudio.ai`
 * @homepage https://lmstudio.ai
 */
export const lmstudioaiPackage = {
  name: 'LM Studio' as const,
  domain: 'lmstudio.ai' as const,
  description: 'A desktop app for discovering, downloading, and running local LLMs.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://lmstudio.ai' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install lmstudio.ai' as const,
  programs: ['lm-studio'] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '0.4.23-1',
    '0.4.22-1',
    '0.4.21-2',
    '0.4.20-1',
    '0.4.19-2',
    '0.4.18-1',
    '0.3.8',
    '0.3.7',
  ] as const,
  aliases: ['lm-studio', 'lmstudio'] as const,
}
export type LmstudioaiPackage = typeof lmstudioaiPackage
