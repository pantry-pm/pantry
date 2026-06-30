/**
 * **Roboto** - Google's signature family of fonts.
 *
 * @domain `roboto`
 * @version `2.138`
 *
 * @install `pantry install roboto`
 * @homepage https://fonts.google.com/specimen/Roboto
 */
export const robotoPackage = {
  name: 'Roboto' as const,
  domain: 'roboto' as const,
  description: 'Google\'s signature family of fonts.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://fonts.google.com/specimen/Roboto' as const,
  githubUrl: 'https://github.com/googlefonts/roboto' as const,
  installCommand: 'pantry install roboto' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '2.138',
    '2.136',
    '2.135',
    '2.134',
    '2.133',
    '2.132',
    '2.131',
    '2.129',
  ] as const,
  aliases: [] as const,
}
export type RobotoPackage = typeof robotoPackage
