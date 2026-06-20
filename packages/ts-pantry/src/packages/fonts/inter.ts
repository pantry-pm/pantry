/**
 * **Inter** - Typeface designed for screens.
 *
 * @domain `inter`
 * @version `4.1`
 * @install `pantry install inter`
 * @homepage https://rsms.me/inter/
 */
export const interPackage = {
  name: 'Inter' as const,
  domain: 'inter' as const,
  description: 'Typeface designed for screens.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://rsms.me/inter/' as const,
  githubUrl: 'https://github.com/rsms/inter' as const,
  installCommand: 'pantry install inter' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: ['4.1'] as const,
  aliases: [] as const,
}
export type InterPackage = typeof interPackage
