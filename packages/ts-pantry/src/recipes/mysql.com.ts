import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'mysql.com',
  name: 'mysql',
  description: 'MySQL Server, the world\\s most popular open source database, and MySQL Cluster, a real-time, open source transactional database.',
  homepage: 'https://www.mysql.com/',
  github: 'https://github.com/mysql/mysql-server',
  programs: ['mysql_client_test', 'my_print_defaults', 'myisam_ftdump', 'myisamchk', 'myisamlog', 'myisampack', 'mysql', 'mysql_config', 'mysql_config_editor', 'mysql_keyring_encryption_test', 'mysql_migrate_keyring', 'mysql_secure_installation', 'mysql_tzinfo_to_sql', 'mysqladmin', 'mysqlbinlog', 'mysqlcheck', 'mysqld', 'mysqld_multi', 'mysqld_safe', 'mysqldump', 'mysqldumpslow', 'mysqlimport', 'mysqlrouter', 'mysqlrouter_keyring', 'mysqlrouter_passwd', 'mysqlrouter_plugin_info', 'mysqlshow', 'mysqlslap', 'mysqltest', 'mysqltest_safe_process', 'mysqlxtest'],
  versionSource: {
    type: 'github-releases',
    repo: 'mysql/mysql-server',
    tagPattern: /^v(.+)$/,
  },
  distributable: {
    url: 'https://cdn.mysql.com/Downloads/MySQL-{{version.marketing}}/mysql-boost-{{version}}.tar.gz',
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
      'sed -i -e \\s/\\(STRING_APPEND.*moutline-atomics.*\\)/# \\1/\\ ../CMakeLists.txt',
      'run: export ARGS="$(echo $ARGS | sed \\s/WITH_ZLIB=system/WITH_ZLIB=bundled/g\\)"',
      'run: export ARGS="$ARGS -DCMAKE_C_STANDARD=17"',
      // Use pantry deps for SSL + ICU so the runtime binary doesn't depend on
      // the build host's system libs.
      'run: export ARGS="$ARGS -DWITH_SSL={{deps.openssl.org.prefix}} -DWITH_ICU={{deps.unicode.org.prefix}}"',
      'cmake .. $ARGS',
      'make --jobs {{hw.concurrency}} install',
    ],
  },
}
