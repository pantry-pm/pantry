/**
 * **Cursor** - An AI-first code editor built for pair programming.
 *
 * @domain `cursor.com`
 * @programs `cursor`
 * @version `0.45.11` (3 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install cursor.com`
 * @homepage https://cursor.com
 */
export const cursorcomPackage = {
  name: 'Cursor' as const,
  domain: 'cursor.com' as const,
  description: 'An AI-first code editor built for pair programming.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://cursor.com' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install cursor.com' as const,
  programs: ['cursor'] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '3.15.6',
    '3.14.27',
    '3.14.7',
    '3.13.25',
    '3.13.21',
    '3.13.10',
    '3.12.30',
    '3.12.29',
    '3.12.17',
    '3.12.10',
    '3.11.25',
    '3.11.19',
    '3.11.13',
    '3.10.20',
    '3.10.17',
    '3.10.11',
    '3.9.16',
    '0.45.11',
    '0.45.10',
    '0.45.9',
  ] as const,
  aliases: ['cursor'] as const,
}
export type CursorcomPackage = typeof cursorcomPackage
