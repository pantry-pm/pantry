/**
 * **Hack** - A typeface designed for source code.
 *
 * @domain `hack`
 * @version `3.003`
 * @install `pantry install hack`
 * @homepage https://sourcefoundry.org/hack/
 */
export const hackPackage = {
  name: 'Hack' as const,
  domain: 'hack' as const,
  description: 'A typeface designed for source code.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://sourcefoundry.org/hack/' as const,
  githubUrl: 'https://github.com/source-foundry/Hack' as const,
  installCommand: 'pantry install hack' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: ['3.003'] as const,
  aliases: [] as const,
}
export type HackPackage = typeof hackPackage
