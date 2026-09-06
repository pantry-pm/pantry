/**
 * **libuv** - Cross-platform asynchronous I/O
 *
 * @domain `libuv.org`
 * @version `1.52.1` (100 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install libuv.org`
 * @homepage https://libuv.org/
 * @buildDependencies `curl.se` - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.libuvorg
 * console.log(pkg.name)        // "libuv"
 * console.log(pkg.description) // "Cross-platform asynchronous I/O"
 * console.log(pkg.versions[0]) // "1.52.1" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/libuv-org.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const libuvorgPackage = {
  /**
  * The display name of this package.
  */
  name: 'libuv' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'libuv.org' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'Cross-platform asynchronous I/O' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/libuv.org/package.yml' as const,
  homepageUrl: 'https://libuv.org/' as const,
  githubUrl: 'https://github.com/libuv/libuv' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install libuv.org' as const,
  pantryInstallCommand: 'pantry install libuv.org' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'curl.se',
  ] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '1.52.1',
    '1.52.0',
    '1.51.0',
    '1.50.0',
    '1.49.2',
    '1.49.1',
    '1.49.0',
    '1.48.0',
    '1.47.0',
    '1.46.0',
    '1.45.0',
    '1.44.2',
    '1.44.1',
    '1.44.0',
    '1.43.0',
    '1.42.1',
    '1.42.0',
    '1.41.1',
    '1.41.0',
    '1.40.0',
    '1.39.0',
    '1.38.1',
    '1.38.0',
    '1.37.0',
    '1.36.0',
    '1.35.0',
    '1.34.2',
    '1.34.1',
    '1.34.0',
    '1.33.1',
    '1.33.0',
    '1.32.0',
    '1.31.0',
    '1.30.1',
    '1.30.0',
    '1.29.1',
    '1.29.0',
    '1.28.0',
    '1.27.0',
    '1.26.0',
    '1.25.0',
    '1.24.1',
    '1.24.0',
    '1.23.2',
    '1.23.1',
    '1.23.0',
    '1.22.0',
    '1.21.0',
    '1.20.3',
    '1.20.2',
    '1.20.1',
    '1.20.0',
    '1.19.2',
    '1.19.1',
    '1.19.0',
    '1.18.0',
    '1.17.0',
    '1.16.1',
    '1.16.0',
    '1.15.0',
    '1.14.1',
    '1.14.0',
    '1.13.1',
    '1.13.0',
    '1.12.0',
    '1.11.0',
    '1.10.2',
    '1.10.1',
    '1.10.0',
    '1.9.1',
    '1.9.0',
    '1.8.0',
    '1.7.5',
    '1.7.4',
    '1.7.3',
    '1.7.2',
    '1.7.1',
    '1.7.0',
    '1.6.1',
    '1.6.0',
    '1.5.0',
    '1.4.2',
    '1.4.1',
    '1.4.0',
    '1.3.0',
    '1.2.1',
    '1.2.0',
    '1.1.0',
    '1.0.2',
    '1.0.1',
    '1.0.0',
    '1.0.0-rc2',
    '1.0.0-rc1',
    '0.11.29',
    '0.11.28',
    '0.11.27',
    '0.11.26',
    '0.11.25',
    '0.11.24',
    '0.11.23',
  ] as const,
  aliases: [] as const,
}

export type LibuvorgPackage = typeof libuvorgPackage
