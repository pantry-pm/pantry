import type { Recipe } from '../../scripts/recipe-types'

/**
 * NOTE: this build script does not run in CI.
 *
 * duckdb.org is not in CUSTOM_BUILD_DOMAINS (scripts/build-all-packages.ts), so
 * the publish pipeline mirrors pkgx's official prebuilt instead of compiling:
 * every version logs "Mirrored duckdb.org@x from pkgx — no source build". The
 * recipe is still what documents the source build and what a local or forced
 * build uses, but nothing added to `ARGS` reaches the binary `pantry install`
 * delivers.
 *
 * That matters for extensions specifically. Adding -DBUILD_HTTPFS_EXTENSION=1
 * here looks like it would ship an httpfs-enabled CLI and does not; the shipped
 * binary has no httpfs, and consumers must `INSTALL httpfs` into an
 * `extension_directory` at setup time. Making the flag real would mean adding
 * this domain to CUSTOM_BUILD_DOMAINS and source-building a large C++ project
 * across every supported version and platform, which is not worth it when the
 * extensions install at runtime in seconds. The two domains that are custom
 * builds (php.net, postgresql.org) are there because their build-time options
 * have no runtime equivalent. DuckDB's do.
 */

export const recipe: Recipe = {
  domain: 'duckdb.org',
  name: 'duckdb',
  description: 'DuckDB is an analytical in-process SQL database management system',
  homepage: 'https://www.duckdb.org',
  github: 'https://github.com/duckdb/duckdb',
  programs: ['duckdb'],
  versionSource: {
    type: 'github-releases',
    repo: 'duckdb/duckdb',
  },
  distributable: {
    url: 'https://github.com/duckdb/duckdb/archive/refs/tags/v{{version}}.tar.gz',
    stripComponents: 1,
  },
  buildDependencies: {
    'cmake.org': '^3',
    'git-scm.org': '*',
    'python.org': '^3',
  },

  build: {
    'working-directory': 'build',
    workingDirectory: 'build',
    script: [
      // duckdb uses git to get its version
      'git init ..',
      'git config user.email "bot@pkgx.dev"',
      'git config user.name "pkgxbot"',
      'git commit --allow-empty -mnil',
      'git tag v{{version}}',
      // $ARGS must be referenced explicitly or the extension flags never reach
      // cmake (the previous plain `cmake ..` built no extensions at all).
      'cmake .. $ARGS',
      'make --jobs {{hw.concurrency}}',
      'mkdir -p "{{prefix}}"/bin',
      'mv duckdb "{{prefix}}"/bin',
    ],
    env: {
      'ARGS': ['-DCMAKE_INSTALL_PREFIX={{prefix}}', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_ICU_EXTENSION=1', '-DBUILD_JSON_EXTENSION=1', '-DBUILD_PARQUET_EXTENSION=1'],
    },
  },
}
