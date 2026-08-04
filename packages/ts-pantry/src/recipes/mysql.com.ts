import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'mysql.com',
  name: 'mysql',
  description: 'MySQL Server, the world\\s most popular open source database, and MySQL Cluster, a real-time, open source transactional database.',
  homepage: 'https://www.mysql.com/',
  github: 'https://github.com/mysql/mysql-server',
  programs: ['mysql_client_test', 'my_print_defaults', 'myisam_ftdump', 'myisamchk', 'myisamlog', 'myisampack', 'mysql', 'mysql_config', 'mysql_config_editor', 'mysql_keyring_encryption_test', 'mysql_migrate_keyring', 'mysql_secure_installation', 'mysql_tzinfo_to_sql', 'mysqladmin', 'mysqlbinlog', 'mysqlcheck', 'mysqld', 'mysqld_multi', 'mysqld_safe', 'mysqldump', 'mysqldumpslow', 'mysqlimport', 'mysqlrouter', 'mysqlrouter_keyring', 'mysqlrouter_passwd', 'mysqlrouter_plugin_info', 'mysqlshow', 'mysqlslap', 'mysqltest', 'mysqltest_safe_process', 'mysqlxtest'],
  // github-releases tags (mysql-server) surface "innovation" versions (9.x)
  // whose source tarball is never published on the CDN, so a build for one
  // fails with a 404 and - worse - the registry used to fall back to pkgx's
  // vanilla binary, which links an external ICU the registry does not carry.
  // See CUSTOM_BUILD_DOMAINS in packages/registry/src/pkgx-fallback.ts.
  //
  // So versions are not taken on trust: candidates come from the 8.0 GA line
  // and each is kept only if its `mysql-boost-` tarball actually exists. That
  // is what makes this self-maintaining - a new 8.0 patch is picked up on its
  // own, and anything unbuildable never reaches the catalog.
  versionSource: {
    type: 'custom',
    fetch: async () => {
      // The CDN is the only authority for what can actually be built, so it
      // is asked directly rather than inferred from git tags.
      //
      // GitHub's tag list is not usable here: mysql-server is tagged
      // `mysql-cluster-8.0.48` for MySQL Cluster, a different product whose
      // numbering does not track the server's, so trusting it advertises
      // versions with no server tarball. Trusting the tags is also how the
      // 9.x "innovation" releases got into the catalog in the first place -
      // they are tagged but never published as source.
      const FLOOR = 43 // 8.0.43, the oldest release this recipe is known to build
      const MAX_PROBES = 24
      const STOP_AFTER_MISSES = 3

      const exists = async (version: string): Promise<boolean> => {
        try {
          const res = await fetch(
            `https://cdn.mysql.com/archives/mysql-8.0/mysql-boost-${version}.tar.gz`,
            { method: 'HEAD' },
          )
          return res.ok
        }
        catch {
          return false
        }
      }

      const found: string[] = []
      let misses = 0
      for (let patch = FLOOR; patch < FLOOR + MAX_PROBES && misses < STOP_AFTER_MISSES; patch++) {
        const version = `8.0.${patch}`
        // eslint-disable-next-line no-await-in-loop
        if (await exists(version)) {
          found.push(version)
          misses = 0
        }
        else {
          misses++
        }
      }

      // Never hand back an empty catalog on a bad network day: removing the
      // package outright is worse than serving the last known-good release.
      return found.length > 0 ? found.reverse() : [`8.0.${FLOOR}`]
    },
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
    // openssl 3.x is soname-stable (libssl.so.3), so the pantry dep matches at
    // runtime. ICU is NOT (libicuuc.so.<major>): the registry only carries the
    // latest ICU, so a build pinned to .so.73 won't load — ICU is bundled
    // statically instead (see -DWITH_ICU=bundled).
    'openssl.org': '^3',
    // Sun RPC (rpc/rpc.h) was dropped from glibc >= 2.32; MySQL's MYSQL_CHECK_RPC
    // needs it. libtirpc provides it (header at <prefix>/include/tirpc, lib
    // libtirpc.so.3) — declared so the runtime dep resolves on the box. The build
    // host also installs libtirpc-dev so cmake finds /usr/include/tirpc/rpc/rpc.h.
    'sourceforge.net/libtirpc': '*',
  },

  // GCC 15 emits the `.base64` assembler directive (binutils >= 2.44), but it
  // otherwise picks up the host's `/usr/bin/as` (2.42) which rejects it, failing
  // every compile. Depend on a current binutils and point GCC at its `as`/`ld`
  // with `-B` (see CFLAGS below).
  buildDependencies: {
    'gnu.org/binutils': '*',
  },

  build: {
    'working-directory': 'build',
    script: [
      // Use the pantry binutils `as` (>= 2.44, understands GCC 15's `.base64`)
      // instead of the host /usr/bin/as (2.42). -B makes GCC search this dir for
      // as/ld first; prepended so it wins.
      'export CFLAGS="-B{{deps.gnu.org/binutils.prefix}}/bin ${CFLAGS:-}"',
      'export CXXFLAGS="-B{{deps.gnu.org/binutils.prefix}}/bin ${CXXFLAGS:-}"',
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
      // Install into the pantry prefix; MySQL otherwise defaults to
      // /usr/local/mysql and `make install` fails (no write permission).
      'export ARGS="$ARGS -DCMAKE_INSTALL_PREFIX={{prefix}}"',
      'export ARGS="$ARGS -DCMAKE_C_STANDARD=17"',
      // Use pantry deps for SSL + ICU so the runtime binary doesn't depend on
      // the build host's system libs.
      // openssl from pantry (soname-stable so.3); ICU bundled (static) so mysqld
      // has no external libicuuc.so.<major> the registry can't version-match.
      // `-DWITH_SSL=system`, not a `{{deps.openssl.org.prefix}}` template.
      // That placeholder was never substituted - it reached cmake verbatim,
      // which failed with "Wrong option or path for
      // WITH_SSL={{deps.openssl.org.prefix}}" and killed every build. So the
      // fix this recipe was written to make (link current openssl/ICU instead
      // of the long-gone libssl.so.1.1 and libicuuc.so.71) never actually
      // shipped, and the registry kept serving the broken artifact.
      //
      // `system` is correct here rather than a workaround: the build image is
      // Ubuntu 24.04, whose openssl is 3.x, so the binary links libssl.so.3 -
      // the same soname the `openssl.org: ^3` runtime dependency provides on
      // the target box. ICU stays bundled because its soname carries the
      // major version (libicuuc.so.<major>) and the registry only ever
      // carries one ICU, so an external link cannot be version-matched.
      'export ARGS="$ARGS -DWITH_SSL=system -DWITH_ICU=bundled"',
      // The mysql-boost tarball bundles the exact boost MySQL needs at <src>/boost.
      'export ARGS="$ARGS -DWITH_BOOST=../boost"',
      // Skip the bundled googletest unit tests: a build-tool dep (ninja) puts its
      // own gtest headers on CPATH, which shadow MySQL's vendored googletest and
      // break the gmock/gtest compile. The server doesn't need unit tests.
      'export ARGS="$ARGS -DWITH_UNIT_TESTS=OFF"',
      // Use MySQL's vendored protobuf 24.4 (source + its own protoc). A pantry
      // protobuf (v21) on CPATH otherwise shadows the bundled headers and the
      // generated .pb.cc fails to compile ("ClassData does not name a type").
      // The pantry protobuf dep is removed from the catalog so it isn't installed.
      'export ARGS="$ARGS -DWITH_PROTOBUF=bundled"',
      // Disable LTO/IPO entirely. MySQL (and/or CMake IPO) enable -flto, whose
      // GCC fat-LTO `.base64` assembly the build`s `as` rejects; WITH_LTO=OFF +
      // INTERPROCEDURAL_OPTIMIZATION=OFF keep it off for every target (the bundled
      // zlib was getting -flto via IPO, bypassing the CFLAGS/wrapper scrubbing).
      'export ARGS="$ARGS -DWITH_LTO=OFF -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF"',
      'cmake .. $ARGS',
      'make --jobs {{hw.concurrency}} install',
      // MySQL installs its bundled shared libs (e.g. libprotobuf-lite.so) into
      // <prefix>/lib/private with an $ORIGIN rpath. pantry's `pantry env` only
      // adds <pkg>/lib (not lib/private) to LD_LIBRARY_PATH, so mysqld can't find
      // them at runtime. Hoist them into <prefix>/lib so they resolve.
      'if [ -d {{prefix}}/lib/private ]; then mv {{prefix}}/lib/private/*.so* {{prefix}}/lib/ 2>/dev/null || true; fi',
      'if [ -d {{prefix}}/lib/mysql/private ]; then mv {{prefix}}/lib/mysql/private/*.so* {{prefix}}/lib/ 2>/dev/null || true; fi',
    ],
  },
}
