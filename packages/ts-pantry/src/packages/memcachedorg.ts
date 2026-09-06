/**
 * **memcached** - pkgx package
 *
 * @domain `memcached.org`
 * @programs `memcached`
 *
 * @install `pantry install memcached.org`
 * @dependencies `libevent.org`
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.memcachedorg
 * console.log(pkg.name)        // "memcached"
 * console.log(pkg.programs)    // ["memcached"]
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/memcached-org.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const memcachedorgPackage = {
  /**
  * The display name of this package.
  */
  name: 'memcached' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'memcached.org' as const,
  /**
  * Brief description of what this package does.
  */
  description: '' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/memcached.org/package.yml' as const,
  homepageUrl: '' as const,
  githubUrl: '' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install memcached.org' as const,
  pantryInstallCommand: 'pantry install memcached.org' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'memcached',
  ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  */
  dependencies: [
    'libevent.org',
  ] as const,
  buildDependencies: [] as const,
  versions: [
    '1.6.45',
    '1.6.44',
    '1.6.43',
    '1.6.42',
    '1.6.41',
    '1.6.40',
    '1.6.39',
    '1.6.38',
    '1.6.37',
    '1.6.36',
    '1.6.35',
    '1.6.34',
    '1.6.33',
    '1.6.32',
    '1.6.31',
    '1.6.30',
    '1.6.29',
    '1.6.28',
    '1.6.27',
    '1.6.26',
    '1.6.25',
    '1.6.24',
    '1.6.23',
    '1.6.22',
    '1.6.21',
    '1.6.20',
    '1.6.19',
    '1.6.18',
    '1.6.17',
    '1.6.16',
    '1.6.15',
    '1.6.14',
    '1.6.13',
    '1.6.12',
    '1.6.11',
    '1.6.10',
    '1.6.9',
    '1.6.8',
    '1.6.7',
    '1.6.6',
    '1.6.5',
    '1.6.4',
    '1.6.3',
    '1.6.2',
    '1.6.1',
    '1.6.0',
    '1.6.0-beta1',
    '1.5.22',
    '1.5.21',
  ] as const,
  aliases: [] as const,
}

export type MemcachedorgPackage = typeof memcachedorgPackage
