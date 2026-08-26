import type { Recipe } from '../../scripts/recipe-types'

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
  // httpfs links against OpenSSL at runtime, so it is a runtime dependency,
  // not just a build one.
  dependencies: {
    'openssl.org': '^1.1',
  },
  buildDependencies: {
    'cmake.org': '^3',
    'git-scm.org': '*',
    'python.org': '^3',
    'openssl.org': '^1.1',
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
      // httpfs is compiled in statically so `LOAD httpfs` needs no network
      // access at runtime (consumers read s3:// URLs without an INSTALL step).
      'ARGS': ['-DCMAKE_INSTALL_PREFIX={{prefix}}', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_ICU_EXTENSION=1', '-DBUILD_JSON_EXTENSION=1', '-DBUILD_PARQUET_EXTENSION=1', '-DBUILD_HTTPFS_EXTENSION=1', '-DOPENSSL_ROOT_DIR={{deps.openssl.org.prefix}}'],
    },
  },
}
