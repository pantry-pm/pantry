/**
 * **DBeaver** - A universal database tool for developers and database administrators.
 *
 * @domain `dbeaver.io`
 * @programs `dbeaver`
 * @version `26.2.4` (22 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install dbeaver.io`
 * @homepage https://dbeaver.io
 */
export const dbeaverioPackage = {
  name: 'DBeaver' as const,
  domain: 'dbeaver.io' as const,
  description: 'A universal database tool for developers and database administrators.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://dbeaver.io' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install dbeaver.io' as const,
  programs: ['dbeaver'] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '26.2.4',
    '26.2.3',
    '26.2.2',
    '26.2.1',
    '26.2.0',
    '26.1.5',
    '26.1.4',
    '26.1.3',
    '26.1.2',
    '26.1.1',
    '26.1.0',
    '26.0.5',
    '26.0.4',
    '26.0.3',
    '26.0.2',
    '26.0.1',
    '26.0.0',
    '25.3.5',
    '25.3.4',
    '25.3.3',
    '24.3.4',
    '24.3.3',
  ] as const,
  aliases: ['dbeaver'] as const,
}
export type DbeaverioPackage = typeof dbeaverioPackage
