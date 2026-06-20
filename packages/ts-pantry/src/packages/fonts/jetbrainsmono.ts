/**
 * **JetBrains Mono** - A typeface for developers.
 *
 * @domain `jetbrains-mono`
 * @version `2.304`
 * @install `pantry install jetbrains-mono`
 * @homepage https://www.jetbrains.com/lp/mono/
 */
export const jetbrainsmonoPackage = {
  name: 'JetBrains Mono' as const,
  domain: 'jetbrains-mono' as const,
  description: 'A typeface for developers.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://www.jetbrains.com/lp/mono/' as const,
  githubUrl: 'https://github.com/JetBrains/JetBrainsMono' as const,
  installCommand: 'pantry install jetbrains-mono' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: ['2.304'] as const,
  aliases: [] as const,
}
export type JetbrainsmonoPackage = typeof jetbrainsmonoPackage
