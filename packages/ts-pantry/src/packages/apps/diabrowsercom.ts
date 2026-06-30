/**
 * **Dia** - An AI-native web browser by The Browser Company.
 *
 * @domain `diabrowser.com`
 * @version `1.36.0`
 *
 * @install `pantry install diabrowser.com`
 * @homepage https://www.diabrowser.com
 */
export const diabrowsercomPackage = {
  name: 'Dia' as const,
  domain: 'diabrowser.com' as const,
  description: 'An AI-native web browser by The Browser Company.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://www.diabrowser.com' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install diabrowser.com' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '1.37.1',
    '1.36.0',
  ] as const,
  aliases: [] as const,
}
export type DiabrowsercomPackage = typeof diabrowsercomPackage
