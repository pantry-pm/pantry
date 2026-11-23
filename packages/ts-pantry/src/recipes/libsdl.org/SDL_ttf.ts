import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'libsdl.org/SDL_ttf',
  name: 'SDL_ttf',
  revisions: { '2.24.0': 1 },
  revisionReasons: { '2.24.0': 'elf-loader-paths' },
  programs: [],
  dependencies: {
    'freetype.org': '>=2.0.4',
    'harfbuzz.org': '>=2.3.1',
    'libsdl.org': '^2.0.10',
  },
  distributable: {
    url: 'https://github.com/libsdl-org/SDL_ttf/releases/download/release-{{version}}/SDL{{version.major}}_ttf-{{version}}.tar.gz',
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
        '--disable-freetype-builtin',
        '--disable-harfbuzz-builtin',
      ],
    },
  },
  test: {
    script: [
      'cc $FIXTURE -lSDL2_ttf',
      './a.out',
    ],
  },
}
