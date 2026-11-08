/**
 * **CleanShot X** - A screen capture and recording tool for macOS.
 *
 * @domain `cleanshot.com`
 * @programs `cleanshot`
 * @version `5.0.2` (22 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install cleanshot.com`
 * @homepage https://cleanshot.com
 */
export const cleanshotcomPackage = {
  name: 'CleanShot X' as const,
  domain: 'cleanshot.com' as const,
  description: 'A screen capture and recording tool for macOS.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://cleanshot.com' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install cleanshot.com' as const,
  programs: ['cleanshot'] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '5.0.2',
    '5.0.1',
    '5.0',
    '4.8.11',
    '4.8.10',
    '4.8.9',
    '4.8.8',
    '4.8.7',
    '4.8.6',
    '4.8.5',
    '4.8.4',
    '4.8.3',
    '4.8.2',
    '4.8.1',
    '4.8',
    '4.7.8',
    '4.7.7',
    '4.7.6',
    '4.7.5',
    '4.7.4',
    '4.7.3',
    '4.7.2',
  ] as const,
  aliases: ['cleanshot'] as const,
}
export type CleanshotcomPackage = typeof cleanshotcomPackage
