import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'gnu.org/which',
  name: 'which',
  revisions: { '2.23.0': 1 },
  revisionReasons: { '2.23.0': 'elf-loader-paths' },
  programs: [
    'which',
  ],
  distributable: {
    url: 'https://ftp.gnu.org/gnu/which/which-{{version.raw}}.tar.gz',
    stripComponents: 1,
  },
  build: {
    script: [
      {
        run: 'sed -i \'s/extern int getopt();/extern int getopt(int, char * const [], const char *);/\' getopt.h',
        if: 'darwin',
      },
      './configure $ARGS',
      'make --jobs {{ hw.concurrency }} install',
    ],
    env: {
      ARGS: [
        '--prefix={{prefix}}',
        '--disable-dependency-tracking',
      ],
    },
  },
}
