/**
 * **czmq** - High-level C binding for ZeroMQ
 *
 * @domain `zeromq.org/czmq`
 * @version `4.2.1`
 * @versions From newest version to oldest.
 *
 * @install `pantry install zeromq.org/czmq`
 * @name `czmq`
 * @homepage https://zeromq.org
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.czmq
 * console.log(pkg.name)        // "czmq"
 * console.log(pkg.versions[0]) // "4.2.1" (latest)
 * ```
 */
export const czmqPackage = {
  /**
  * The display name of this package.
  */
  name: 'czmq' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'zeromq.org/czmq' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'High-level C binding for ZeroMQ' as const,
  // First-party: not mirrored from pkgx; the recipe lives in this repository. Needed by prime_server.
  packageYmlUrl: 'https://github.com/pantry-pm/pantry/tree/main/packages/ts-pantry/src/recipes/zeromq.org/czmq.ts' as const,
  homepageUrl: 'https://zeromq.org' as const,
  githubUrl: 'https://github.com/zeromq/czmq' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install zeromq.org/czmq' as const,
  pantryInstallCommand: 'pantry install zeromq.org/czmq' as const,
  /**
  * Executable programs provided by this package.
  */
  programs: [] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  */
  dependencies: [
    'zeromq.org^4.2',
  ] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'freedesktop.org/pkg-config',
  ] as const,
  /**
  * Available versions from newest to oldest.
  */
  versions: [
    '4.2.1',
  ] as const,
  /**
  * Alternative names for this package.
  */
  aliases: [
    'czmq',
  ] as const,
}

export type CzmqPackage = typeof czmqPackage
