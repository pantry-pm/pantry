import type { Recipe } from '../../scripts/recipe-types'

const programs = ['clusterdb', 'createdb', 'dropdb', 'dropuser', 'ecpg', 'initdb', 'pg_archivecleanup', 'pg_basebackup', 'pg_config', 'pg_controldata', 'pg_ctl', 'pg_dump', 'pg_dumpall', 'pg_isready', 'pg_receivewal', 'pg_recvlogical', 'pg_resetwal', 'pg_restore', 'pg_rewind', 'pg_test_fsync', 'pg_test_timing', 'pg_upgrade', 'pg_waldump', 'pgbench', 'postgres', 'psql', 'reindexdb', 'vacuumdb']

export const recipe: Recipe = {
  domain: 'postgresql.org',
  name: 'postgresql',
  description: 'Mirror of the official PostgreSQL GIT repository',
  homepage: 'https://www.postgresql.org/',
  github: 'https://github.com/postgres/postgres',
  programs,
  // 18.6 shipped with a literal /../lib ELF path. Preserve that identity and
  // require the current source/relocation pipeline for its packaging repair.
  revisions: { '18.6': 1 },
  versionSource: {
    // postgres/postgres is a mirror with no GitHub Releases — it tags stable
    // releases as REL_<major>_<minor> (e.g. REL_17_10). Read tags and join the
    // two capture groups into a "<major>.<minor>" version.
    type: 'github-tags',
    repo: 'postgres/postgres',
    tagPattern: /^REL_(\d+)_(\d+)$/,
  },
  distributable: {
    url: 'https://github.com/postgres/postgres/archive/refs/tags/REL_{{version.major}}_{{version.minor}}.tar.gz',
    stripComponents: 1,
  },
  dependencies: {
    'openssl.org': '^3',
    'gnu.org/readline': '*',
    'zlib.net': '*',
    'lz4.org': '*',
    // PostgreSQL 17.6+ supports libxml2 2.14+; compile against the same
    // explicit library series as libxslt instead of loading two XML ABIs.
    'gnome.org/libxml2': '~2.15.1',
    'gnome.org/libxslt': '*',
    'unicode.org': '^73',
  },
  buildDependencies: {
    'gnu.org/bison': '*',
    'github.com/westes/flex': '^2.5.31',
    'perl.org': '*',
  },

  build: {
    script: [
      'export CFLAGS="$(echo $CFLAGS | tr \' \' \'\\n\' | sed -e \'/^-w$/d\' | tr \'\\n\' \' \')"',
      'sed -i \'s|\\([^\\t]*sgml.*\\)$|#\\1|\' GNUmakefile.in doc/src/Makefile',
      './configure $ARGS',
      'make --jobs {{hw.concurrency}}',
      'make install-world',
    ],
    env: {
      darwin: { MACOSX_DEPLOYMENT_TARGET: '14.0' },
      'CC': 'clang',
      'CXX': 'clang++',
      'LD': 'clang',
      'ARGS': ['--prefix={{prefix}}', '--with-ssl=openssl', '--with-lz4', '--with-libxml', '--with-libxslt'],
      'CFLAGS': '$CFLAGS -Wno-incompatible-function-pointer-types',
    },
  },
  test: {
    required: true,
    // A server/version-only check misses libpq-dependent client tools. Loader
    // overrides on the build host would conceal the broken shipped RPATH.
    script: [
      `for tool in ${programs.join(' ')}; do env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH "{{prefix}}/bin/$tool" --version; done`,
    ],
  },
}
