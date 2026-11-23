import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'gnu.org/grep',
  name: 'grep',
  revisions: { '3.12.0': 1 },
  revisionReasons: { '3.12.0': 'elf-loader-paths' },
  programs: [
    'grep',
  ],
  dependencies: {
    'pcre.org/v2': '*',
  },
  buildDependencies: {
    'freedesktop.org/pkg-config': '^0.29',
  },
  distributable: {
    url: 'https://ftp.gnu.org/gnu/grep/grep-{{version.raw}}.tar.gz',
    stripComponents: 1,
  },
  build: {
    script: [
      './configure $ARGS',
      'make --jobs {{ hw.concurrency }} install',
    ],
    env: {
      ARGS: [
        '--prefix={{prefix}}',
        '--disable-nls',
        '--mandir={{prefix}}/man',
        '--infodir={{prefix}}/info',
        '-with-packager=tea',
      ],
    },
  },
  test: {
    script: [
      'grep -P match $FIXTURE',
    ],
  },
}
