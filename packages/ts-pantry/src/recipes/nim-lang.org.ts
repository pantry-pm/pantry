import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'nim-lang.org',
  name: 'nim-lang',
  description: 'Nim is a statically typed compiled systems programming language. It combines successful concepts from mature languages like Python, Ada and Modula. Its design focuses on efficiency, expressiveness, and elegance (in that order of priority).',
  homepage: 'https://nim-lang.org',
  github: 'https://github.com/nim-lang/Nim',
  programs: ['nim', 'nim_dbg', 'testament', 'nimsuggest', 'nimgrep', 'nim-gdb', 'atlas', 'nimpretty', 'nimble'],
  versionSource: {
    type: 'github-tags',
    repo: 'nim-lang/Nim',
  },
  distributable: {
    url: 'https://nim-lang.org/download/nim-{{version}}.tar.xz',
    stripComponents: 1,
  },

  build: {
    script: [
      'sh build.sh',
      './bin/nim c koch',
      './koch boot -d:release',
      './koch tools',
      './install.sh {{prefix}}',
      // install.sh puts everything under {{prefix}}/nim (nim/bin, nim/lib, ...).
      // Lift it into the prefix, or nothing lands in {{prefix}}/bin.
      {
        run: [
          'rm -rf nim/compiler',
          'cp -r nim/* .',
          'rm -rf nim',
        ],
        'working-directory': '{{prefix}}',
      },
      // install.sh installs the compiler only; `koch tools` left the rest in bin/.
      {
        run: 'cp $BINS {{prefix}}/bin/',
        'working-directory': 'bin',
      },
    ],
    env: {
      BINS: ['atlas', 'nim', 'nim-gdb', 'nim_dbg', 'nimble', 'nimgrep', 'nimpretty', 'nimsuggest', 'testament'],
    },
  },
}
