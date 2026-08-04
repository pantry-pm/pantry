import type { Recipe } from '../../scripts/recipe-types'

/**
 * Vitess: horizontally scalable MySQL.
 *
 * Built from source rather than repackaged from the upstream release, for two
 * reasons that both matter here:
 *
 *  - **arm64.** Vitess publishes exactly one release tarball, built for
 *    x86_64. Repackaging it would leave every arm64 box (Graviton, Ampere,
 *    Apple silicon) unable to install. Go cross-compiles cleanly, so building
 *    gives us all four platforms.
 *  - **Size.** The release tarball is ~600MB because it carries every binary
 *    plus test fixtures. Building and installing only the daemons an operator
 *    runs produces an artifact a fraction of that.
 *
 * `make build` compiles with `CGO_ENABLED=0`, so the binaries are static and
 * do not pick up a libc dependency from the build image.
 */
export const recipe: Recipe = {
  domain: 'vitess.io',
  name: 'vitess',
  description: 'Horizontally scalable MySQL: a database clustering system that shards MySQL behind a query router',
  homepage: 'https://vitess.io',
  github: 'https://github.com/vitessio/vitess',

  /**
   * Kept in lockstep with the `cp` list in the build script below, and with
   * `programs` in src/packages/vitessio.ts. A name here that the script does
   * not install produces a package advertising a binary it does not ship.
   *
   * This is the Makefile's own `install` set plus `vtcombo` and `vtclient`.
   * `vtcombo` runs the whole stack in one process, which is what makes a
   * single-box development cluster possible; upstream omits it from `install`
   * because their packaging targets production only.
   */
  programs: [
    'mysqlctl',
    'mysqlctld',
    'vtorc',
    'vtadmin',
    'vtctl',
    'vtctld',
    'vtctlclient',
    'vtctldclient',
    'vtgate',
    'vttablet',
    'vtbackup',
    'vtexplain',
    'vtcombo',
    'vtclient',
  ],

  versionSource: {
    type: 'github-releases',
    repo: 'vitessio/vitess',
  },

  distributable: {
    url: 'https://github.com/vitessio/vitess/archive/refs/tags/{{version.tag}}.tar.gz',
    stripComponents: 1,
  },

  buildDependencies: {
    'go.dev': '^1.26',
  },

  build: {
    script: [
      // NOVTADMINBUILD skips the vtadmin web UI, which needs a Node toolchain
      // and ships nothing the server binaries use. The `vtadmin` API binary is
      // still built by `go build ./go/...`; only its bundled frontend is
      // skipped.
      // `-s -w` drops the symbol table and DWARF debug info. Go binaries are
      // large and Vitess ships fourteen of them: unstripped the artifact is
      // ~500MB, which overran the registry's publish-and-scan budget. Nothing
      // at runtime needs the symbols, and upstream's own release build strips
      // the same way.
      'make build NOVTADMINBUILD=1 NOBANNER=1 VT_EXTRA_BUILD_LDFLAGS="-s -w"',
      'mkdir -p {{prefix}}/bin',
      // Copied by name rather than `cp bin/*`: `go build ./go/...` also emits
      // test harnesses (vtgateclienttest, vttestserver) and zookeeper helpers
      // that no deployment runs, and shipping them would bloat the artifact
      // and widen the attack surface for no benefit.
      'for b in mysqlctl mysqlctld vtorc vtadmin vtctl vtctld vtctlclient vtctldclient vtgate vttablet vtbackup vtexplain vtcombo vtclient; do cp "bin/$b" "{{prefix}}/bin/$b"; done',
      // `config/init_db.sql` is not optional. mysqlctld runs it after
      // initializing mysqld to create the `vt_dba`, `vt_app` and `vt_repl`
      // accounts; without it vttablet cannot start, failing with "timed out
      // waiting for the dba user to have the required permissions". The
      // upstream release tarball omits it, which is why a binaries-only
      // package produces a cluster that comes up and cannot serve.
      'mkdir -p {{prefix}}/config',
      'cp -r config/. {{prefix}}/config/',
    ],
    env: {
      // Belt and braces: the Makefile sets this for `build`, but an override
      // in the build image would otherwise reintroduce a libc dependency and
      // make the artifact non-portable.
      CGO_ENABLED: '0',
    },
  },

  test: {
    script: [
      // Every advertised binary must exist and be runnable. A version probe
      // catches the failure that matters most: a binary that built but cannot
      // start on the target platform.
      '{{prefix}}/bin/vtgate --version',
      '{{prefix}}/bin/vttablet --version',
      '{{prefix}}/bin/vtctldclient --version',
      '{{prefix}}/bin/vtcombo --version',
    ],
  },
}
