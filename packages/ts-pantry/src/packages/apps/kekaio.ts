/**
 * **Keka** - A file archiver for macOS.
 *
 * @domain `keka.io`
 * @programs `keka`
 * @version `1.6.8` (20 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install keka.io`
 * @homepage https://keka.io
 */
export const kekaioPackage = {
  name: 'Keka' as const,
  domain: 'keka.io' as const,
  description: 'A file archiver for macOS.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://keka.io' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install keka.io' as const,
  programs: ['keka'] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '1.6.8',
    '1.6.7',
    '1.6.6',
    '1.6.5',
    '1.6.4',
    '1.6.3',
    '1.6.2',
    '1.6.1',
    '1.6.0',
    '1.5.2',
    '1.5.1',
    '1.5.0',
    '1.4.8',
    '1.4.7',
    '1.4.6',
    '1.4.5',
    '1.4.4',
    '1.4.3',
    '1.4.2',
    '1.4.1',
  ] as const,
  aliases: ['keka'] as const,
}
export type KekaioPackage = typeof kekaioPackage
