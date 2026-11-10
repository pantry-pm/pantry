/**
 * **Brave Browser** - A privacy-focused web browser that blocks ads and trackers.
 *
 * @domain `brave.com`
 * @programs `brave`
 * @version `1.101.38` (26 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install brave.com`
 * @homepage https://brave.com
 */
export const bravecomPackage = {
  name: 'Brave Browser' as const,
  domain: 'brave.com' as const,
  description: 'A privacy-focused web browser that blocks ads and trackers.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://brave.com' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install brave.com' as const,
  programs: ['brave'] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '1.101.38',
    '1.101.37',
    '1.101.36',
    '1.101.32',
    '1.101.31',
    '1.101.28',
    '1.101.27',
    '1.101.26',
    '1.101.25',
    '1.101.23',
    '1.101.21',
    '1.101.18',
    '1.101.17',
    '1.101.16',
    '1.101.15',
    '1.101.8',
    '1.101.5',
    '1.101.4',
    '1.101.3',
    '1.100.49',
    '1.100.48',
    '1.100.44',
    '1.100.43',
    '1.74.48',
    '1.74.47',
    '1.74.46',
  ] as const,
  aliases: ['brave'] as const,
}
export type BravecomPackage = typeof bravecomPackage
