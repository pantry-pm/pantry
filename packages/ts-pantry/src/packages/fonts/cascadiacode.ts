/**
 * **Cascadia Code** - Microsofts monospaced coding font.
 *
 * @domain `cascadia-code`
 * @version `2407.24`
 * @install `pantry install cascadia-code`
 * @homepage https://github.com/microsoft/cascadia-code
 */
export const cascadiacodePackage = {
  name: 'Cascadia Code' as const,
  domain: 'cascadia-code' as const,
  description: 'Microsofts monospaced coding font.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://github.com/microsoft/cascadia-code' as const,
  githubUrl: 'https://github.com/microsoft/cascadia-code' as const,
  installCommand: 'pantry install cascadia-code' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: ['2407.24'] as const,
  aliases: [] as const,
}
export type CascadiacodePackage = typeof cascadiacodePackage
