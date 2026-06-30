/**
 * **Lato** - A sans-serif typeface family by Łukasz Dziedzic.
 *
 * @domain `lato`
 * @version `2.0`
 *
 * @install `pantry install lato`
 * @homepage https://www.latofonts.com/
 */
export const latoPackage = {
  name: 'Lato' as const,
  domain: 'lato' as const,
  description: 'A sans-serif typeface family by Łukasz Dziedzic.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://www.latofonts.com/' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install lato' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '2.015',
    '2.0',
  ] as const,
  aliases: [] as const,
}
export type LatoPackage = typeof latoPackage
