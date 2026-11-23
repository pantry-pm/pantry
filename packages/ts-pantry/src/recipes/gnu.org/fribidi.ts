import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'gnu.org/fribidi',
  name: 'fribidi',
  revisions: { '1.0.16': 1 },
  revisionReasons: { '1.0.16': 'elf-loader-paths' },
  programs: [
    'fribidi',
  ],
  distributable: {
    url: 'https://github.com/fribidi/fribidi/releases/download/v{{ version }}/fribidi-{{ version }}.tar.xz',
    stripComponents: 1,
  },
  build: {
    script: [
      './configure --prefix={{prefix}} --disable-debug',
      'make --jobs={{ hw.concurrency }} install',
    ],
  },
  test: {
    script: [
      'out="$(fribidi --charset=CapRTL --clean --nobreak $FIXTURE)"',
      'test "$out" = "a simple TSet that"',
    ],
  },
}
