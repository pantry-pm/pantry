import type { Recipe } from '../../../../scripts/recipe-types'

/**
 * prime_server: the non-blocking HTTP server and load-balanced worker
 * pipeline Valhalla's `valhalla_service` runs on (ZeroMQ underneath).
 *
 * Cloned rather than downloaded: its logging header and test harness are git
 * submodules (gists), which GitHub's source archives leave out.
 */
export const recipe: Recipe = {
  domain: 'github.com/kevinkreiser/prime_server',
  name: 'prime_server',
  description: 'Non-blocking web server API for distributed service-oriented applications',
  homepage: 'https://github.com/kevinkreiser/prime_server',
  github: 'https://github.com/kevinkreiser/prime_server',
  programs: ['prime_httpd', 'prime_proxyd', 'prime_workerd', 'prime_serverd', 'prime_echod', 'prime_filed'],
  platforms: ['linux/x86-64', 'linux/aarch64', 'darwin/aarch64'],
  versionSource: {
    type: 'github-releases',
    repo: 'kevinkreiser/prime_server',
    tagPattern: /^(\d+\.\d+\.\d+)$/,
    stable: true,
  },
  distributable: {
    url: 'git+https://github.com/kevinkreiser/prime_server',
    ref: '{{version}}',
  },
  dependencies: {
    'zeromq.org': '^4.2',
    'zeromq.org/czmq': '^4',
    'curl.se': '*',
  },
  buildDependencies: {
    'cmake.org': '*',
    'freedesktop.org/pkg-config': '*',
    'git-scm.org': '^2',
  },

  build: {
    script: [
      'git submodule update --init --recursive src/logging',
      'cmake -S . -B build $ARGS',
      'cmake --build build --parallel {{hw.concurrency}}',
      'cmake --install build',
    ],
    env: {
      ARGS: [
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_INSTALL_PREFIX={{prefix}}',
        '-DCMAKE_INSTALL_LIBDIR=lib',
        '-DENABLE_TESTS=OFF',
        '-DENABLE_WERROR=OFF',
      ],
    },
  },
  test: {
    script: [
      'test -x {{prefix}}/bin/prime_httpd',
      'test -f {{prefix}}/include/prime_server/prime_server.hpp',
    ],
  },
}
