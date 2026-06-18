import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'mysql.com',
  name: 'mysql',
  description: 'MySQL Server, the world\\s most popular open source database, and MySQL Cluster, a real-time, open source transactional database.',
  homepage: 'https://www.mysql.com/',
  github: 'https://github.com/mysql/mysql-server',
  programs: ['mysql_client_test', 'my_print_defaults', 'myisam_ftdump', 'myisamchk', 'myisamlog', 'myisampack', 'mysql', 'mysql_config', 'mysql_config_editor', 'mysql_keyring_encryption_test', 'mysql_migrate_keyring', 'mysql_secure_installation', 'mysql_tzinfo_to_sql', 'mysqladmin', 'mysqlbinlog', 'mysqlcheck', 'mysqld', 'mysqld_multi', 'mysqld_safe', 'mysqldump', 'mysqldumpslow', 'mysqlimport', 'mysqlrouter', 'mysqlrouter_keyring', 'mysqlrouter_passwd', 'mysqlrouter_plugin_info', 'mysqlshow', 'mysqlslap', 'mysqltest', 'mysqltest_safe_process', 'mysqlxtest'],
  // github-releases tags (mysql-server) surface phantom "innovation" versions
  // (e.g. 9.6.0) whose source tarball isn't published on the CDN, so the build
  // would no-op as "source unavailable". Pin to the latest 8.0 GA, whose
  // `mysql-boost-` archive tarball (bundled boost the build needs) is published.
  versionSource: {
    type: 'custom',
    fetch: async () => ['8.0.43'],
  },
  distributable: {
    // The archive host serves stable, never-moving source URLs. 8.4+ dropped the
    // bundled-boost tarball; 8.0.x keeps `mysql-boost-<version>.tar.gz`.
    url: 'https://cdn.mysql.com/archives/mysql-{{version.marketing}}/mysql-boost-{{version}}.tar.gz',
    stripComponents: 1,
  },

  // Link against pantry-built libs so the binary runs on a clean box. The
  // published mirror needed libssl.so.1.1 / libicuuc.so.71 (long gone); pin the
  // current majors and point cmake at them (WITH_SSL / WITH_ICU).
  dependencies: {
    'openssl.org': '^3',
    'unicode.org': '^73',
    // Sun RPC (rpc/rpc.h) was dropped from glibc >= 2.32; MySQL's MYSQL_CHECK_RPC
    // needs it. libtirpc provides it (header at <prefix>/include/tirpc, lib
    // libtirpc.so.3) — declared so the runtime dep resolves on the box. The build
    // host also installs libtirpc-dev so cmake finds /usr/include/tirpc/rpc/rpc.h.
    'sourceforge.net/libtirpc': '*',
  },

  build: {
    'working-directory': 'build',
    script: [
      // Comment out the ARM -moutline-atomics STRING_APPEND (no-op match on x86).
      // The sed expression must be single-quoted; the previous backslash-escaped
      // form rendered to `\s/…` which sed rejects ("unknown command: `/`").
      'sed -i -e \'s/\\(STRING_APPEND.*moutline-atomics.*\\)/# \\1/\' ../CMakeLists.txt || true',
      // Strip inherited LTO flags at the source. GCC fat-LTO objects encode with
      // the `.base64` assembler directive that the build`s `as` rejects; the
      // cc-wrapper drops `-flto` per-invocation, but flags reach some bundled
      // sub-builds (zlib) another way — clearing CFLAGS/CXXFLAGS/LDFLAGS here means
      // cmake never puts `-flto` into CMAKE_*_FLAGS, so no compile ever sees it.
      'export CFLAGS="$(echo "${CFLAGS:-}" | sed -E \'s/-flto[^ ]*//g; s/-ffat-lto-objects//g\')"',
      'export CXXFLAGS="$(echo "${CXXFLAGS:-}" | sed -E \'s/-flto[^ ]*//g; s/-ffat-lto-objects//g\')"',
      'export LDFLAGS="$(echo "${LDFLAGS:-}" | sed -E \'s/-flto[^ ]*//g; s/-ffat-lto-objects//g\')"',
      // Plain command strings — a leading `run:` is NOT stripped by buildkit
      // (that's the object-step form `{ run: … }`), it would emit a literal
      // `run:` into the script ("run:: command not found").
      'export ARGS="$(echo $ARGS | sed \'s/WITH_ZLIB=system/WITH_ZLIB=bundled/g\')"',
      'export ARGS="$ARGS -DCMAKE_C_STANDARD=17"',
      // Use pantry deps for SSL + ICU so the runtime binary doesn't depend on
      // the build host's system libs.
      'export ARGS="$ARGS -DWITH_SSL={{deps.openssl.org.prefix}} -DWITH_ICU={{deps.unicode.org.prefix}}"',
      // The mysql-boost tarball bundles the exact boost MySQL needs at <src>/boost.
      'export ARGS="$ARGS -DWITH_BOOST=../boost"',
      // Skip the bundled googletest unit tests: a build-tool dep (ninja) puts its
      // own gtest headers on CPATH, which shadow MySQL's vendored googletest and
      // break the gmock/gtest compile. The server doesn't need unit tests.
      'export ARGS="$ARGS -DWITH_UNIT_TESTS=OFF"',
      // Disable LTO/IPO entirely. MySQL (and/or CMake IPO) enable -flto, whose
      // GCC fat-LTO `.base64` assembly the build`s `as` rejects; WITH_LTO=OFF +
      // INTERPROCEDURAL_OPTIMIZATION=OFF keep it off for every target (the bundled
      // zlib was getting -flto via IPO, bypassing the CFLAGS/wrapper scrubbing).
      'export ARGS="$ARGS -DWITH_LTO=OFF -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF"',
      'cmake .. $ARGS',
      // VERBOSE so any remaining compile failure shows the exact command/flags.
      'make VERBOSE=1 --jobs {{hw.concurrency}} install',
    ],
  },
}
