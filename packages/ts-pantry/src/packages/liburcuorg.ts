/**
 * **liburcu** - liburcu is a LGPLv2.1 userspace RCU (read-copy-update) library. This data synchronization library provides read-side access which scales linearly with the number of cores.
 *
 * @domain `liburcu.org`
 * @version `0.15.6` (100 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install liburcu.org`
 * @homepage http://liburcu.org
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.liburcuorg
 * console.log(pkg.name)        // "liburcu"
 * console.log(pkg.description) // "liburcu is a LGPLv2.1 userspace RCU (read-copy-..."
 * console.log(pkg.versions[0]) // "0.15.6" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/liburcu-org.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const liburcuorgPackage = {
  /**
  * The display name of this package.
  */
  name: 'liburcu' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'liburcu.org' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'liburcu is a LGPLv2.1 userspace RCU (read-copy-update) library. This data synchronization library provides read-side access which scales linearly with the number of cores.' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/liburcu.org/package.yml' as const,
  homepageUrl: 'http://liburcu.org' as const,
  githubUrl: 'https://github.com/urcu/userspace-rcu' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install liburcu.org' as const,
  pantryInstallCommand: 'pantry install liburcu.org' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '0.15.6',
    '0.15.5',
    '0.15.4',
    '0.15.3',
    '0.15.2',
    '0.15.1',
    '0.15.0',
    '0.14.2',
    '0.14.1',
    '0.14.0',
    '0.13.4',
    '0.13.3',
    '0.13.2',
    '0.13.1',
    '0.13.0',
    '0.12.5',
    '0.12.4',
    '0.12.3',
    '0.12.2',
    '0.12.1',
    '0.12.0',
    '0.11.4',
    '0.11.3',
    '0.11.2',
    '0.11.1',
    '0.11.0',
    '0.10.3',
    '0.10.2',
    '0.10.1',
    '0.10.0',
    '0.9.7',
    '0.9.6',
    '0.9.5',
    '0.9.4',
    '0.9.3',
    '0.9.2',
    '0.9.1',
    '0.9.0',
    '0.8.11',
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
    '0.7.17',
    '0.7.16',
    '0.7.15',
    '0.7.14',
    '0.7.13',
    '0.7.12',
    '0.7.11',
    '0.7.10',
    '0.7.9',
    '0.7.8',
    '0.7.7',
    '0.7.6',
    '0.7.5',
    '0.7.4',
    '0.7.3',
    '0.7.2',
    '0.7.1',
    '0.7.0',
    '0.6.9',
    '0.6.8',
    '0.6.7',
    '0.6.6',
    '0.6.5',
    '0.6.4',
    '0.6.3',
    '0.6.2',
    '0.6.1',
    '0.6.0',
    '0.5.4',
    '0.5.3',
    '0.5.2',
    '0.5.1',
    '0.5.0',
    '0.4.8',
    '0.4.7',
    '0.4.6',
    '0.4.5',
    '0.4.4',
    '0.4.3',
    '0.4.2',
    '0.4.1',
    '0.4.0',
    '0.3.4',
    '0.3.3',
    '0.3.2',
    '0.3.1',
    '0.3.0',
    '0.2.4',
    '0.2.3',
    '0.2.2',
  ] as const,
  aliases: [] as const,
}

export type LiburcuorgPackage = typeof liburcuorgPackage
