import type { Recipe } from '../../../scripts/recipe-types'

/**
 * readosm: a small C library that reads OpenStreetMap .osm and .osm.pbf
 * files. Needed by spatialite-tools, whose spatialite_osm_* loaders use it.
 */
export const recipe: Recipe = {
  domain: 'gaia-gis.it/readosm',
  name: 'readosm',
  description: 'C library for reading OpenStreetMap input files (.osm and .osm.pbf)',
  homepage: 'https://www.gaia-gis.it/fossil/readosm',
  programs: [],
  platforms: ['linux/x86-64', 'linux/aarch64', 'darwin/aarch64'],
  // Upstream also ships letter-suffixed rebuilds (1.1.0a) of the same
  // release; the plain tarballs are the releases.
  versionSource: {
    type: 'url-pattern',
    url: 'https://www.gaia-gis.it/gaia-sins/readosm-sources/readosm-{{version}}.tar.gz',
    knownVersions: ['1.1.0'],
  },
  distributable: {
    url: 'https://www.gaia-gis.it/gaia-sins/readosm-sources/readosm-{{version}}.tar.gz',
    stripComponents: 1,
  },
  dependencies: {
    'libexpat.github.io': '^2',
    'zlib.net': '^1',
  },
  buildDependencies: {
    'gnu.org/make': '*',
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
      'pkg-config --modversion readosm | grep {{version}}',
    ],
  },
}
