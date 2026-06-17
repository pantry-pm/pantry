import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: "gnu.org/readline",
  name: "readline",
  programs: [],
  dependencies: {
    'invisible-island.net/ncurses': "^6",
  },
  distributable: {
    url: "https://ftp.gnu.org/gnu/readline/readline-{{ version.raw }}.tar.gz",
    stripComponents: 1,
  },
  build: {
    script: [
      "./configure --prefix={{ prefix }} --with-curses",
      "make --jobs {{ hw.concurrency }} install",
    ],
    env: {
      linux: {
        // The termcap globals readline uses (UP/BC/PC) live in libtinfow, not
        // libncursesw — link it explicitly so libreadline.so records the
        // dependency (DT_NEEDED) and resolves them at load time. Without this,
        // psql/mysql crash with "undefined symbol: UP".
        LDFLAGS: "$LDFLAGS -lncursesw -ltinfow",
      },
    },
  },
  test: {
    script: [
      "ldd {{prefix}}/lib/libreadline.so | grep ncurses\ncc -lreadline -lncurses -ltinfo fixture.c",
      "otool -L {{prefix}}/lib/libreadline.dylib | grep ncurses\ncc -lreadline -lncurses fixture.c",
      "test \"$(echo \"Hello, World!\" | ./a.out)\" = \"test> Hello, World!\nHello, World!\\\\n\"\n",
    ],
  },
}
