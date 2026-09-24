/**
 * **readosm** - C library for reading OpenStreetMap input files (.osm and .osm.pbf)
 *
 * @domain `gaia-gis.it/readosm`
 * @version `1.1.0`
 * @versions From newest version to oldest.
 *
 * @install `pantry install gaia-gis.it/readosm`
 * @name `readosm`
 * @homepage https://www.gaia-gis.it/fossil/readosm
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.gaiagisitreadosm
 * console.log(pkg.name)        // "readosm"
 * console.log(pkg.versions[0]) // "1.1.0" (latest)
 * ```
 */
export const gaiagisitreadosmPackage = {
  /**
  * The display name of this package.
  */
  name: 'readosm' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'gaia-gis.it/readosm' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'C library for reading OpenStreetMap input files (.osm and .osm.pbf)' as const,
  // First-party: not mirrored from pkgx; the recipe lives in this repository. Needed by spatialite-tools.
  packageYmlUrl: 'https://github.com/pantry-pm/pantry/tree/main/packages/ts-pantry/src/recipes/gaia-gis.it/readosm.ts' as const,
  homepageUrl: 'https://www.gaia-gis.it/fossil/readosm' as const,
  githubUrl: '' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install gaia-gis.it/readosm' as const,
  pantryInstallCommand: 'pantry install gaia-gis.it/readosm' as const,
  /**
  * Executable programs provided by this package.
  */
  programs: [] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  */
  dependencies: [
    'libexpat.github.io^2',
    'zlib.net^1',
  ] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'gnu.org/make',
  ] as const,
  /**
  * Available versions from newest to oldest.
  */
  versions: [
    '1.1.0',
  ] as const,
  /**
  * Alternative names for this package.
  */
  aliases: [
    'readosm',
  ] as const,
}

export type GaiagisitreadosmPackage = typeof gaiagisitreadosmPackage
