/**
 * **IINA** - A modern media player for macOS.
 *
 * @domain `iina.io`
 * @programs `iina`
 * @version `1.3.5` (2 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install iina.io`
 * @homepage https://iina.io
 */
export const iinaioPackage = {
  name: 'IINA' as const,
  domain: 'iina.io' as const,
  description: 'A modern media player for macOS.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://iina.io' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install iina.io' as const,
  programs: ['iina'] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '1.4.4',
    '1.4.3',
    '1.4.2',
    '1.4.2-build164',
    '1.4.1',
    '1.4.0',
    '1.3.5',
    '1.3.4',
    '1.3.3',
    '1.3.2',
    '1.3.1',
    '1.3.0',
    '1.2.0',
    '1.1.2',
    '1.1.1-build125',
    '1.1.0',
    '1.0.7',
    '1.0.6',
    '1.0.5',
    '1.0.4',
    '1.0.3',
    '1.0.2',
    '1.0.1',
    '1.0.0',
    '0.0.15.1',
    '0.0.15',
    '0.0.14.1',
    '0.0.14',
    '0.0.13',
    '0.0.12',
    '0.0.11',
    '0.0.10',
  ] as const,
  aliases: ['iina'] as const,
}
export type IinaioPackage = typeof iinaioPackage
