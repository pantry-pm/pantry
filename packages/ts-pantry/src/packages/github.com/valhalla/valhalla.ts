/**
 * **valhalla** - Open source routing engine for OpenStreetMap, with tools for time-dependent routing, isochrones, map matching and elevation
 *
 * @domain `github.com/valhalla/valhalla`
 * @programs `valhalla_service`, `valhalla_build_tiles`, `valhalla_build_config`, `valhalla_build_elevation`, `valhalla_build_admins`, `valhalla_build_timezones`, `valhalla_build_extract`, `valhalla_add_elevation`, `valhalla_run_route`
 * @version `3.9.0`
 * @versions From newest version to oldest.
 *
 * @install `pantry install github.com/valhalla/valhalla`
 * @name `valhalla`
 * @homepage https://valhalla.github.io/valhalla/
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.valhalla
 * console.log(pkg.name)        // "valhalla"
 * console.log(pkg.versions[0]) // "3.9.0" (latest)
 * ```
 */
export const valhallaPackage = {
  /**
  * The display name of this package.
  */
  name: 'valhalla' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'github.com/valhalla/valhalla' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'Open source routing engine for OpenStreetMap, with tools for time-dependent routing, isochrones, map matching and elevation' as const,
  // First-party: not mirrored from pkgx; the recipe lives in this repository.
  packageYmlUrl: 'https://github.com/pantry-pm/pantry/tree/main/packages/ts-pantry/src/recipes/github.com/valhalla/valhalla.ts' as const,
  homepageUrl: 'https://valhalla.github.io/valhalla/' as const,
  githubUrl: 'https://github.com/valhalla/valhalla' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install github.com/valhalla/valhalla' as const,
  pantryInstallCommand: 'pantry install github.com/valhalla/valhalla' as const,
  /**
  * Executable programs provided by this package.
  */
  programs: [
    'valhalla_service',
    'valhalla_build_tiles',
    'valhalla_build_config',
    'valhalla_build_elevation',
    'valhalla_build_admins',
    'valhalla_build_timezones',
    'valhalla_build_extract',
    'valhalla_add_elevation',
    'valhalla_run_route',
  ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  */
  dependencies: [
    'protobuf.dev',
    'abseil.io',
    'zlib.net',
    'lz4.org',
    'curl.se',
    'sqlite.org',
    'gaia-gis.it/libspatialite',
    'libgeos.org',
    'luajit.org',
    'github.com/kevinkreiser/prime_server>=0.11',
    'zeromq.org^4.2',
    'zeromq.org/czmq^4',
    'python.org^3',
  ] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'boost.org>=1.71',
    'cmake.org',
    'freedesktop.org/pkg-config',
    'git-scm.org^2',
  ] as const,
  /**
  * Available versions from newest to oldest.
  */
  versions: [
    '3.9.0',
  ] as const,
  /**
  * Alternative names for this package.
  */
  aliases: [
    'valhalla',
  ] as const,
}

export type ValhallaPackage = typeof valhallaPackage
