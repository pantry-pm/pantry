import type { Recipe } from '../../../scripts/recipe-types'

/**
 * spatialite-tools: the command-line side of SpatiaLite — the `spatialite`
 * SQL shell, `spatialite_tool` for shapefile import/export, and the OSM
 * loaders. Valhalla's valhalla_build_timezones needs both of the first two
 * to build its timezone database.
 *
 * readline is declared rather than detected, so the shell's line editing
 * links the registry's copy and not the build runner's.
 */
export const recipe: Recipe = {
  domain: 'gaia-gis.it/spatialite-tools',
  name: 'spatialite-tools',
  description: 'Command-line tools for SpatiaLite: the spatialite SQL shell, spatialite_tool, and OpenStreetMap loaders',
  homepage: 'https://www.gaia-gis.it/fossil/spatialite-tools',
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
  ],
  platforms: ['linux/x86-64', 'linux/aarch64', 'darwin/aarch64'],
  // As with readosm, the letter-suffixed tarballs (5.1.0a) are rebuilds of
  // the plain release.
  versionSource: {
    type: 'url-pattern',
    url: 'https://www.gaia-gis.it/gaia-sins/spatialite-tools-sources/spatialite-tools-{{version}}.tar.gz',
    knownVersions: ['5.1.0'],
  },
  distributable: {
    url: 'https://www.gaia-gis.it/gaia-sins/spatialite-tools-sources/spatialite-tools-{{version}}.tar.gz',
    stripComponents: 1,
  },
  dependencies: {
    'gaia-gis.it/libspatialite': '>=5.1',
    'gaia-gis.it/readosm': '^1.1',
    'gaia-gis.it/fossil/freexl': '*',
    'sqlite.org': '^3',
    'libexpat.github.io': '^2',
    'gnome.org/libxml2': '^2',
    'proj.org': '*',
    'libgeos.org': '*',
    'gnu.org/readline': '^8',
    'zlib.net': '^1',
  },
  buildDependencies: {
    'gnu.org/make': '*',
    'freedesktop.org/pkg-config': '*',
  },
  build: {
    script: [
      './configure $ARGS',
      'make --jobs {{ hw.concurrency }} install',
    ],
    env: {
      ARGS: [
        '--disable-dependency-tracking',
        '--prefix={{prefix}}',
        '--enable-readline',
        '--enable-readosm',
      ],
      'linux/aarch64': {
        ARGS: [
          '--build=aarch64-unknown-linux-gnu',
        ],
      },
    },
  },
  test: {
    script: [
      'spatialite :memory: "SELECT spatialite_version();"',
      'test -x {{prefix}}/bin/spatialite_tool',
    ],
  },
}
