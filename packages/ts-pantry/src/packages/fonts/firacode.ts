/**
 * **Fira Code** - Monospaced font with programming ligatures.
 *
 * @domain `fira-code`
 * @version `6.2`
 * @install `pantry install fira-code`
 * @homepage https://github.com/tonsky/FiraCode
 */
export const firacodePackage = {
  name: 'Fira Code' as const,
  domain: 'fira-code' as const,
  description: 'Monospaced font with programming ligatures.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://github.com/tonsky/FiraCode' as const,
  githubUrl: 'https://github.com/tonsky/FiraCode' as const,
  installCommand: 'pantry install fira-code' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: ['6.2'] as const,
  aliases: [] as const,
}
export type FiracodePackage = typeof firacodePackage
