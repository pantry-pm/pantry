/**
 * **Pearcleaner** - Open-source application uninstaller for macOS.
 *
 * @domain `pearcleaner.app`
 * @version `5.4.3`
 *
 * @install `pantry install pearcleaner.app`
 * @homepage https://github.com/alienator88/Pearcleaner
 */
export const pearcleanerappPackage = {
  name: 'Pearcleaner' as const,
  domain: 'pearcleaner.app' as const,
  description: 'Open-source application uninstaller for macOS.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://github.com/alienator88/Pearcleaner' as const,
  githubUrl: 'https://github.com/alienator88/Pearcleaner' as const,
  installCommand: 'pantry install pearcleaner.app' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: ['5.4.3'] as const,
  aliases: [] as const,
}
export type PearcleanerappPackage = typeof pearcleanerappPackage
