/**
 * **prime_server** - Non-blocking web server API for distributed service-oriented applications
 *
 * @domain `github.com/kevinkreiser/prime_server`
 * @programs `prime_httpd`, `prime_proxyd`, `prime_workerd`, `prime_serverd`, `prime_echod`, `prime_filed`
 * @version `0.13.1`
 * @versions From newest version to oldest.
 *
 * @install `pantry install github.com/kevinkreiser/prime_server`
 * @name `prime_server`
 * @homepage https://github.com/kevinkreiser/prime_server
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.prime_server
 * console.log(pkg.name)        // "prime_server"
 * console.log(pkg.versions[0]) // "0.13.1" (latest)
 * ```
 */
export const primeserverPackage = {
  /**
  * The display name of this package.
  */
  name: 'prime_server' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'github.com/kevinkreiser/prime_server' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'Non-blocking web server API for distributed service-oriented applications' as const,
  // First-party: not mirrored from pkgx; the recipe lives in this repository. The HTTP layer valhalla_service runs on.
  packageYmlUrl: 'https://github.com/pantry-pm/pantry/tree/main/packages/ts-pantry/src/recipes/github.com/kevinkreiser/prime_server.ts' as const,
  homepageUrl: 'https://github.com/kevinkreiser/prime_server' as const,
  githubUrl: 'https://github.com/kevinkreiser/prime_server' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install github.com/kevinkreiser/prime_server' as const,
  pantryInstallCommand: 'pantry install github.com/kevinkreiser/prime_server' as const,
  /**
  * Executable programs provided by this package.
  */
  programs: [
    'prime_httpd',
    'prime_proxyd',
    'prime_workerd',
    'prime_serverd',
    'prime_echod',
    'prime_filed',
  ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  */
  dependencies: [
    'zeromq.org^4.2',
    'zeromq.org/czmq^4',
    'curl.se',
  ] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'cmake.org',
    'freedesktop.org/pkg-config',
    'git-scm.org^2',
  ] as const,
  /**
  * Available versions from newest to oldest.
  */
  versions: [
    '0.13.1',
    '0.13.0',
    '0.12.0',
    '0.11.0',
    '0.10.0',
    '0.9.0',
    '0.8.0',
    '0.7.2',
    '0.7.0',
    '0.6.7',
    '0.6.6',
    '0.6.5',
    '0.6.4',
  ] as const,
  /**
  * Alternative names for this package.
  */
  aliases: [
    'prime_server',
    'prime-server',
  ] as const,
}

export type PrimeserverPackage = typeof primeserverPackage
