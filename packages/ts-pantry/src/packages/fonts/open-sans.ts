/**
 * **Open Sans** - A humanist sans-serif typeface designed by Steve Matteson.
 *
 * @domain `open-sans`
 * @version `3.003`
 *
 * @install `pantry install open-sans`
 * @homepage https://fonts.google.com/specimen/Open+Sans
 */
export const opensansPackage = {
  name: 'Open Sans' as const,
  domain: 'open-sans' as const,
  description: 'A humanist sans-serif typeface designed by Steve Matteson.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://fonts.google.com/specimen/Open+Sans' as const,
  githubUrl: 'https://github.com/googlefonts/opensans' as const,
  installCommand: 'pantry install open-sans' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: ['3.003'] as const,
  aliases: [] as const,
}
export type OpensansPackage = typeof opensansPackage
