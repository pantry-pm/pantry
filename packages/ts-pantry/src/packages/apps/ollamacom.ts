/**
 * **Ollama** - A local LLM runner for running large language models.
 *
 * @domain `ollama.com`
 * @programs `ollama`
 * @version `0.40.16` (23 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install ollama.com`
 * @homepage https://ollama.com
 */
export const ollamacomPackage = {
  name: 'Ollama' as const,
  domain: 'ollama.com' as const,
  description: 'A local LLM runner for running large language models.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://ollama.com' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install ollama.com' as const,
  programs: ['ollama'] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '0.40.16',
    '0.40.15',
    '0.40.14',
    '0.40.13',
    '0.40.12',
    '0.40.11',
    '0.40.10',
    '0.40.9',
    '0.40.8',
    '0.40.7',
    '0.40.6',
    '0.40.5',
    '0.40.4',
    '0.40.3',
    '0.40.2',
    '0.40.1',
    '0.40.0',
    '0.35.1',
    '0.35.0',
    '0.34.4',
    '0.34.3',
    '0.5.7',
    '0.5.6',
  ] as const,
  aliases: ['ollama'] as const,
}
export type OllamacomPackage = typeof ollamacomPackage
