import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'cscope.sourceforge.io',
  name: 'cscope.sourceforge',
  revisions: { '15.9.0': 1 },
  revisionReasons: { '15.9.0': 'elf-loader-paths' },
  description: 'Tool for browsing source code',
  homepage: 'https://cscope.sourceforge.net/',
  programs: ['cscope', 'ocs'],
  distributable: {
    url: 'https://downloads.sourceforge.net/project/cscope/cscope/v{{version.raw}}/cscope-{{version.raw}}.tar.gz',
    stripComponents: 1,
  },
  dependencies: {
    'invisible-island.net/ncurses': '*',
  },

  build: {
    script: [
      './configure $ARGS',
      'make --jobs {{hw.concurrency}} install',
      '',
    ],
    env: {
      'ARGS': ['--prefix={{prefix}}'],
    },
  },
}
