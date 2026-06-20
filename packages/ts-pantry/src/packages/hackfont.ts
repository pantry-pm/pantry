/**
 * **Hack** - A typeface designed for source code.
 *
 * @domain `hack.font`
 * @version `3.003`
 * @install `pantry install hack.font`
 * @homepage https://sourcefoundry.org/hack/
 */
export const hackfontPackage = {
  name: 'Hack' as const,
  domain: 'hack.font' as const,
  description: 'A typeface designed for source code.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://sourcefoundry.org/hack/' as const,
  githubUrl: 'https://github.com/source-foundry/Hack' as const,
  installCommand: 'pantry install hack.font' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: ['3.003'] as const,
  aliases: [] as const,
}
export type HackfontPackage = typeof hackfontPackage
