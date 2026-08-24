import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'gnu.org/readline',
  name: 'readline',
  programs: [],
  dependencies: {
    'invisible-island.net/ncurses': '^6',
  },
  distributable: {
    url: 'https://ftp.gnu.org/gnu/readline/readline-{{ version.raw }}.tar.gz',
    stripComponents: 1,
  },
  build: {
    script: [
      './configure --prefix={{ prefix }} --with-curses',
      "make --jobs {{ hw.concurrency }} SHLIB_LIBS='-L{{deps.invisible-island.net/ncurses.prefix}}/lib -ltinfow' install",
    ],
    env: {
      linux: {
        LDFLAGS: '$LDFLAGS -L{{deps.invisible-island.net/ncurses.prefix}}/lib -lncursesw -ltinfow',
        CPPFLAGS: '$CPPFLAGS -I{{deps.invisible-island.net/ncurses.prefix}}/include',
      },
    },
  },
  test: {
    script: [
      'ldd {{prefix}}/lib/libreadline.so | grep ncurses\ncc -lreadline -lncurses -ltinfo fixture.c',
      'otool -L {{prefix}}/lib/libreadline.dylib | grep ncurses\ncc -lreadline -lncurses fixture.c',
      'test "$(echo "Hello, World!" | ./a.out)" = "test> Hello, World!\nHello, World!\\\\n"\n',
    ],
  },
}
