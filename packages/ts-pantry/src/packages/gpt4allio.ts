export const gpt4allioPackage = {
  name: 'GPT4All' as const, domain: 'gpt4all.io' as const,
  description: 'Run local AI models in the GPT4All desktop app.' as const,
  packageYmlUrl: '' as const, homepageUrl: 'https://gpt4all.io' as const,
  githubUrl: 'https://github.com/nomic-ai/gpt4all' as const,
  installCommand: 'pantry install gpt4all-desktop' as const,
  programs: [] as const, companions: [] as const, dependencies: [] as const, buildDependencies: [] as const,
  versions: ['3.10.0'] as const, aliases: ['gpt4all-desktop', 'gpt4all-app'] as const,
}
export type Gpt4allioPackage = typeof gpt4allioPackage
