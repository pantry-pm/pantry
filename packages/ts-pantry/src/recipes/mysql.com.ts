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
  },

  build: {
    'working-directory': 'build',
    script: [
      // Comment out the ARM -moutline-atomics STRING_APPEND (no-op match on x86).
      // The sed expression must be single-quoted; the previous backslash-escaped
      // form rendered to `\s/…` which sed rejects ("unknown command: `/`").
      'sed -i -e \'s/\\(STRING_APPEND.*moutline-atomics.*\\)/# \\1/\' ../CMakeLists.txt || true',
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
      // Diagnose a configure failure: modern CMake logs probe failures to
      // CMakeConfigureLog.yaml (not CMakeError.log). Also reproduce a minimal
      // pthread compile through the wrapper `gcc` (on PATH) vs the real compiler
      // to localize whether the cc-wrapper breaks try_compile.
      'cmake .. $ARGS || { f=$(find . -name CMakeConfigureLog.yaml | head -1); echo "===== CMAKE_HAVE_LIBC_PTHREAD block ====="; awk "/Performing Test CMAKE_HAVE_LIBC_PTHREAD/{f=1} f{print} f&&/exitCode:/{n++; if(n>=1)exit}" "$f" 2>/dev/null | head -80; echo "===== HAVE_OUTLINE_ATOMICS block (compile-only) ====="; awk "/Performing Test HAVE_OUTLINE_ATOMICS/{f=1} f{print} f&&/exitCode:/{exit}" "$f" 2>/dev/null | head -60; exit 1; }',
      'make --jobs {{hw.concurrency}} install',
    ],
  },
}
