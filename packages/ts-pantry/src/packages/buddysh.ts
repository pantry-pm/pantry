/**
 * **buddy** - AI code review and dependency updates in one teammate
 *
 * @domain `buddy.sh`
 * @programs `buddy`
 * @version `0.11.1`
 * @versions From newest version to oldest.
 *
 * @install `pantry install buddy.sh`
 * @name `buddy`
 * @homepage https://buddy.sh
 * @buildDependencies `curl.se`, `info-zip.org/unzip` - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * // Access the package
 * const pkg = pantry.buddy
 * // Or access via domain
 * const samePkg = pantry.buddysh
 * console.log(pkg === samePkg) // true
 * console.log(pkg.name)        // "buddy"
 * console.log(pkg.programs)    // ["buddy"]
 * console.log(pkg.versions[0]) // "0.11.1" (latest)
 * ```
 */
export const buddyPackage = {
  /**
  * The display name of this package.
  */
  name: 'buddy' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'buddy.sh' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'AI code review and dependency updates in one teammate — reviews pull requests and local changes, gates merges, repairs CI, and keeps dependencies current' as const,
  // First-party: the recipe lives in this repository rather than being mirrored
  // from pkgx's pantry, so there is no upstream package.yml to point at.
  packageYmlUrl: 'https://github.com/pantry-pm/pantry/tree/main/packages/ts-pantry/src/recipes/buddy.sh.ts' as const,
  homepageUrl: 'https://buddy.sh' as const,
  githubUrl: 'https://github.com/stacksjs/buddy' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install buddy.sh' as const,
  pantryInstallCommand: 'pantry install buddy.sh' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'buddy',
  ] as const,
  companions: [] as const,
  dependencies: [] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'curl.se',
    'info-zip.org/unzip',
  ] as const,
  /**
  * Available versions from newest to oldest.
  *
  * Only the newest is listed, and deliberately: buddy's release workflow
  * deletes the platform binaries from older releases (they are ~150 MB a
  * version), so an older tag has no asset left to install. Listing a version
  * whose zips have been pruned would produce a build that 404s.
  */
  versions: [
    '0.11.1',
    '0.11.0',
    '0.10.5',
    '0.10.4',
    '0.10.3',
    '0.10.2',
    '0.10.1',
    '0.10.0',
    '0.9.27',
    '0.9.26',
    '0.9.25',
    '0.9.24',
    '0.9.23',
    '0.9.22',
    '0.9.21',
    '0.9.20',
    '0.9.19',
    '0.9.18',
    '0.9.17',
    '0.9.16',
    '0.9.15',
    '0.9.14',
    '0.9.13',
    '0.9.12',
    '0.9.11',
    '0.9.9',
    '0.9.8',
    '0.9.7',
    '0.9.6',
    '0.9.5',
    '0.9.4',
    '0.8.10',
    '0.8.9',
    '0.8.8',
    '0.8.7',
    '0.8.6',
    '0.8.5',
    '0.8.4',
    '0.8.3',
    '0.8.2',
    '0.8.1',
    '0.8.0',
    '0.7.13',
    '0.7.12',
    '0.7.11',
    '0.7.10',
    '0.7.8',
    '0.7.7',
    '0.7.6',
    '0.7.5',
  ] as const,
  /**
  * Alternative names for this package.
  * You can use any of these names to access the package.
  */
  aliases: [
    'buddy',
  ] as const,
}

export type BuddyPackage = typeof buddyPackage
