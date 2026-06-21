/**
 * **Muzzle** - Silences notifications automatically while screen sharing.
 *
 * @domain `muzzleapp.com`
 * @version `1.9`
 *
 * @install `pantry install muzzleapp.com`
 * @homepage https://muzzleapp.com
 */
export const muzzleappcomPackage = {
  name: 'Muzzle' as const,
  domain: 'muzzleapp.com' as const,
  description: 'Silences notifications automatically while screen sharing.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://muzzleapp.com' as const,
  githubUrl: '' as const,
  installCommand: 'pantry install muzzleapp.com' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  versions: ['1.9'] as const,
  aliases: [] as const,
}
export type MuzzleappcomPackage = typeof muzzleappcomPackage
