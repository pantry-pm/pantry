import type { Recipe } from '../../../scripts/recipe-types'

/**
 * czmq, the high-level C binding for ZeroMQ. Needed by prime_server, the
 * HTTP layer Valhalla's routing service runs on.
 *
 * The optional integrations (libcurl, libmicrohttpd, uuid, systemd, lz4, nss)
 * are switched off rather than autodetected: detection on a CI runner finds
 * the runner's own -dev packages, links them, and ships a library whose
 * dependencies are not on the machine that installs it. Nothing downstream
 * here uses them.
 */
export const recipe: Recipe = {
  domain: 'zeromq.org/czmq',
  name: 'czmq',
  description: 'High-level C binding for ZeroMQ',
  homepage: 'https://zeromq.org',
  github: 'https://github.com/zeromq/czmq',
  programs: [],
  platforms: ['linux/x86-64', 'linux/aarch64', 'darwin/aarch64'],
  versionSource: {
    type: 'github-releases',
    repo: 'zeromq/czmq',
    tagPattern: /^v(\d+\.\d+\.\d+)$/,
    stable: true,
  },
  distributable: {
    url: 'https://github.com/zeromq/czmq/releases/download/v{{version}}/czmq-{{version}}.tar.gz',
    stripComponents: 1,
  },
  dependencies: {
    'zeromq.org': '^4.2',
  },
  buildDependencies: {
    'freedesktop.org/pkg-config': '*',
  },

  build: {
    script: [
      './configure $ARGS',
      'make --jobs {{hw.concurrency}}',
      'make install',
    ],
    env: {
      ARGS: [
        '--prefix={{prefix}}',
        '--disable-static',
        '--disable-dependency-tracking',
        '--without-docs',
        '--disable-drafts',
        '--with-libcurl=no',
        '--with-libmicrohttpd=no',
        '--with-uuid=no',
        '--with-libsystemd=no',
        '--with-liblz4=no',
        '--with-nss=no',
      ],
    },
  },
  test: {
    script: [
      'test -f {{prefix}}/include/czmq.h',
      'pkg-config --modversion libczmq',
    ],
  },
}
