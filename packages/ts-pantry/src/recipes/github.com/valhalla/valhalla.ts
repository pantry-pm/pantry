import type { Recipe } from '../../../../scripts/recipe-types'

/**
 * Valhalla: open-source routing on OpenStreetMap — turn-by-turn directions
 * for walking, cycling and driving, isochrones, map matching, elevation.
 * `valhalla_service` serves the HTTP API; `valhalla_build_tiles` builds the
 * routing graph from an OSM extract.
 *
 * Cloned rather than downloaded: libosmium, protozero, rapidjson, date and
 * the rest are git submodules, missing from GitHub's source archives.
 *
 * Off: tests, benchmarks, Python bindings (a separate artefact), GeoTIFF
 * (only isochrone raster export), ccache. Services, data tools and HTTP on.
 * `valhalla_build_config` and `valhalla_build_elevation` are Python scripts,
 * hence python.org at runtime.
 */
export const recipe: Recipe = {
  domain: 'github.com/valhalla/valhalla',
  name: 'valhalla',
  description: 'Open source routing engine for OpenStreetMap, with tools for time-dependent routing, isochrones, map matching and elevation',
  homepage: 'https://valhalla.github.io/valhalla/',
  github: 'https://github.com/valhalla/valhalla',
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
  ],
  platforms: ['linux/x86-64', 'linux/aarch64'],
  versionSource: {
    type: 'github-releases',
    repo: 'valhalla/valhalla',
    // Also tagged: `test_tag`, `v3.0.0-rc.1`. Releases are plain X.Y.Z.
    tagPattern: /^(\d+\.\d+\.\d+)$/,
    stable: true,
  },
  distributable: {
    url: 'git+https://github.com/valhalla/valhalla',
    ref: '{{version}}',
  },
  dependencies: {
    // libprotobuf's soname carries the full version (libprotobuf.so.34.1.0),
    // so the one it was built against. '*' also resolved to the catalog's
    // 36.2, which the registry does not have.
    'protobuf.dev': '~34.1',
    // The abseil protobuf.dev was built against (libabsl_*.so.2501): valhalla
    // links libprotobuf, and a newer abseil is a different soname. The latest
    // (20260817) also has no linux-arm64 binary, which sent that build to the
    // runner's /usr.
    'abseil.io': '^20250127',
    'zlib.net': '*',
    'lz4.org': '*',
    'curl.se': '*',
    'sqlite.org': '*',
    'gaia-gis.it/libspatialite': '*',
    'libgeos.org': '*',
    'luajit.org': '*',
    'github.com/kevinkreiser/prime_server': '>=0.11',
    'zeromq.org': '^4.2',
    'zeromq.org/czmq': '^4',
    'python.org': '^3',
  },
  buildDependencies: {
    'boost.org': '>=1.71',
    'cmake.org': '*',
    'freedesktop.org/pkg-config': '*',
    'git-scm.org': '^2',
  },

  build: {
    script: [
      // distributable.ref checked out the release; the vendored libraries
      // are submodules. Tests and bindings stay unfetched.
      'git submodule update --init --recursive --depth 1 third_party/rapidjson third_party/dirent third_party/date third_party/libosmium third_party/protozero third_party/microtar third_party/cpp-statsd-client third_party/cxxopts third_party/just_gtfs third_party/tz third_party/unordered_dense third_party/vtzero third_party/flatbush',
      // CMake insists on spatialite_tool and spatialite, but only the test
      // suite's tz.sqlite uses them, and tests are off. Warn instead.
      // (valhalla_build_timezones needs them at runtime: spatialite-tools.)
      'sed -i.orig \'s/message(FATAL_ERROR "spatialite-tools not found/message(WARNING "spatialite-tools not found/\' CMakeLists.txt',
      'cmake -S . -B build $ARGS',
      'cmake --build build --parallel {{hw.concurrency}}',
      'cmake --install build',
    ],
    env: {
      ARGS: [
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_INSTALL_PREFIX={{prefix}}',
        '-DCMAKE_INSTALL_LIBDIR=lib',
        // protobuf's CMake config looks for abseil; say where it is.
        '-DCMAKE_PREFIX_PATH={{deps.abseil.io.prefix}}',
        '-Dabsl_DIR={{deps.abseil.io.prefix}}/lib/cmake/absl',
        // Valhalla's FindSQLite3 searches the system first and found the
        // runner's /usr/lib copy; link the registry's.
        '-DSQLITE3_INCLUDE_DIR={{deps.sqlite.org.prefix}}/include',
        '-DSQLITE3_LIBRARY={{deps.sqlite.org.prefix}}/lib/libsqlite3.so',
        '-DENABLE_TESTS=OFF',
        '-DENABLE_BENCHMARKS=OFF',
        '-DENABLE_PYTHON_BINDINGS=OFF',
        '-DENABLE_NODE_BINDINGS=OFF',
        '-DENABLE_CCACHE=OFF',
        '-DENABLE_GEOTIFF=OFF',
        '-DENABLE_SINGLE_FILES_WERROR=OFF',
        '-DENABLE_SERVICES=ON',
        '-DENABLE_DATA_TOOLS=ON',
        '-DENABLE_TOOLS=ON',
        '-DENABLE_HTTP=ON',
      ],
    },
  },
  test: {
    script: [
      'valhalla_service --help || test -x {{prefix}}/bin/valhalla_service',
      'test -x {{prefix}}/bin/valhalla_build_tiles',
    ],
  },
}
