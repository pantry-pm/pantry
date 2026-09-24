/**
 * **spatialite-tools** - Command-line tools for SpatiaLite: the spatialite SQL shell, spatialite_tool, and OpenStreetMap loaders
 *
 * @domain `gaia-gis.it/spatialite-tools`
 * @version `5.1.0`
 * @versions From newest version to oldest.
 *
 * @install `pantry install gaia-gis.it/spatialite-tools`
 * @name `spatialite-tools`
 * @homepage https://www.gaia-gis.it/fossil/spatialite-tools
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.gaiagisitspatialitetools
 * console.log(pkg.name)        // "spatialite-tools"
 * console.log(pkg.versions[0]) // "5.1.0" (latest)
 * ```
 */
export const gaiagisitspatialitetoolsPackage = {
  /**
  * The display name of this package.
  */
  name: 'spatialite-tools' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'gaia-gis.it/spatialite-tools' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'Command-line tools for SpatiaLite: the spatialite SQL shell, spatialite_tool, and OpenStreetMap loaders' as const,
  // First-party: not mirrored from pkgx; the recipe lives in this repository. Needed by Valhalla's valhalla_build_timezones.
  packageYmlUrl: 'https://github.com/pantry-pm/pantry/tree/main/packages/ts-pantry/src/recipes/gaia-gis.it/spatialite-tools.ts' as const,
  homepageUrl: 'https://www.gaia-gis.it/fossil/spatialite-tools' as const,
  githubUrl: '' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install gaia-gis.it/spatialite-tools' as const,
  pantryInstallCommand: 'pantry install gaia-gis.it/spatialite-tools' as const,
  /**
  * Executable programs provided by this package.
  */
  programs: [
    'spatialite',
    'spatialite_tool',
    'spatialite_convert',
    'spatialite_dxf',
    'spatialite_gml',
    'spatialite_network',
    'spatialite_osm_filter',
    'spatialite_osm_map',
    'spatialite_osm_net',
    'spatialite_osm_overpass',
    'spatialite_osm_raw',
    'spatialite_xml2utf8',
    'spatialite_xml_collapse',
    'spatialite_xml_load',
    'spatialite_xml_print',
    'spatialite_xml_validator',
    'shp_doctor',
    'shp_sanitize',
    'spatialite_dem',
    'exif_loader',
  ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  */
  dependencies: [
    'gaia-gis.it/libspatialite>=5.1',
    'gaia-gis.it/readosm^1.1',
    'gaia-gis.it/fossil/freexl',
    'sqlite.org^3',
    'libexpat.github.io^2',
    'gnome.org/libxml2^2',
    'proj.org',
    'libgeos.org',
    'gnu.org/readline^8',
    'zlib.net^1',
  ] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'gnu.org/make',
    'freedesktop.org/pkg-config',
  ] as const,
  /**
  * Available versions from newest to oldest.
  */
  versions: [
    '5.1.0',
  ] as const,
  /**
  * Alternative names for this package.
  */
  aliases: [
    'spatialite-tools',
    'spatialite',
  ] as const,
}

export type GaiagisitspatialitetoolsPackage = typeof gaiagisitspatialitetoolsPackage
