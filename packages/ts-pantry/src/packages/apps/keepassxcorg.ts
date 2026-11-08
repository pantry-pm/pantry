/**
 * **KeePassXC** - A cross-platform community-driven password manager.
 *
 * @domain `keepassxc.org`
 * @programs `keepassxc`
 * @version `2.8.0` (20 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install keepassxc.org`
 * @homepage https://keepassxc.org
 */
export const keepassxcorgPackage = {
  name: 'KeePassXC' as const,
  domain: 'keepassxc.org' as const,
  description: 'A cross-platform community-driven password manager.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://keepassxc.org' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install keepassxc.org' as const,
  programs: ['keepassxc'] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '2.8.0',
    '2.7.12',
    '2.7.11',
    '2.7.10',
    '2.7.9',
    '2.7.8',
    '2.7.7',
    '2.7.6',
    '2.7.5',
    '2.7.4',
    '2.7.3',
    '2.7.1',
    '2.7.0',
    '2.6.6',
    '2.6.5',
    '2.6.4',
    '2.6.3',
    '2.6.2',
    '2.6.1',
    '2.6.0',
  ] as const,
  aliases: ['keepassxc'] as const,
}
export type KeepassxcorgPackage = typeof keepassxcorgPackage
