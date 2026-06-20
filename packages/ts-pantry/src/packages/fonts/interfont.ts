/**
 * **Inter** - Typeface designed for screens.
 *
 * @domain `inter.font`
 * @version `4.1`
 * @install `pantry install inter.font`
 * @homepage https://rsms.me/inter/
 */
export const interfontPackage = {
  name: 'Inter' as const,
  domain: 'inter.font' as const,
  description: 'Typeface designed for screens.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://rsms.me/inter/' as const,
  githubUrl: 'https://github.com/rsms/inter' as const,
  installCommand: 'pantry install inter.font' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: ['4.1'] as const,
  aliases: [] as const,
}
export type InterfontPackage = typeof interfontPackage
