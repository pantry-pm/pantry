import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'google.com/fullycapable',
  name: 'fullycapable',
  revisions: { '2.66.0': 1 },
  revisionReasons: { '2.66.0': 'elf-loader-paths' },
  programs: [
    'capsh',
    'getcap',
    'getpcaps',
    'setcap',
  ],
  // pkgx builds x86-64 only, but the registry has served linux-arm64 since
  // before that restriction was ported, so its repair needs an arm64 build.
  platforms: ['linux/x86-64', 'linux/aarch64'],
  distributable: {
    url: 'https://mirrors.edge.kernel.org/pub/linux/libs/security/linux-privs/libcap2/libcap-{{ version.raw }}.tar.xz',
    stripComponents: 1,
  },
  build: {
    script: [
      'make $ARGS --jobs {{ hw.concurrency }} install',
    ],
    env: {
      ARGS: [
        'prefix={{prefix}}',
        'lib=lib',
        'RAISE_SETFCAP=no',
      ],
      CFLAGS: '$CFLAGS -Wno-implicit-function-declaration',
    },
  },
}
