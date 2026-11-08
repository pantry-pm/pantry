/**
 * **1Password** - A password manager and secure vault.
 *
 * @domain `1password.com`
 * @programs `1password`
 * @version `8.12.44` (23 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install 1password.com`
 * @homepage https://1password.com
 */
export const _1passwordcomPackage = {
  name: '1Password' as const,
  domain: '1password.com' as const,
  description: 'A password manager and secure vault.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://1password.com' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install 1password.com' as const,
  programs: ['1password'] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: [
    '8.12.44',
    '8.12.42',
    '8.12.40',
    '8.12.38',
    '8.12.36',
    '8.12.34',
    '8.12.33',
    '8.12.32',
    '8.12.30',
    '8.12.28',
    '8.12.26',
    '8.12.24',
    '8.12.22',
    '8.12.21',
    '8.12.12',
    '8.12.10',
    '8.12.8',
    '8.12.6',
    '8.12.5',
    '8.12.4',
    '8.10.56',
    '8.10.55',
    '8.10.54',
  ] as const,
  aliases: ['1password', 'onepassword'] as const,
}
export type _1passwordcomPackage = typeof _1passwordcomPackage
