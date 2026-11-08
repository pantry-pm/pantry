import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'gnu.org/readline',
  name: 'readline',
  revisions: { '8.3.0': 1 },
  programs: [],
  dependencies: {
    'invisible-island.net/ncurses': '^6',
  },
  distributable: {
    url: 'https://ftp.gnu.org/gnu/readline/readline-{{ version.marketing }}.tar.gz',
    stripComponents: 1,
  },
  build: {
    script: [
      './configure --prefix={{ prefix }} --with-curses',
      "make --jobs {{ hw.concurrency }} SHLIB_LIBS='-L{{deps.invisible-island.net/ncurses.prefix}}/lib -ltinfow' install",
    ],
    env: {
      darwin: { MACOSX_DEPLOYMENT_TARGET: '14.0' },
      linux: {
        LDFLAGS: '$LDFLAGS -L{{deps.invisible-island.net/ncurses.prefix}}/lib -lncursesw -ltinfow',
        CPPFLAGS: '$CPPFLAGS -I{{deps.invisible-island.net/ncurses.prefix}}/include',
      },
    },
  },
  test: {
    required: true,
    script: [
      `cat > readline-consumer.c <<'PANTRY_C'
#include <stdio.h>
#include <readline/readline.h>
#include <readline/history.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
  FILE *input = tmpfile(), *output = tmpfile();
  if (!input || !output) return 1;
  fputs("Pantry readline\\n", input);
  rewind(input);
  rl_instream = input;
  rl_outstream = output;
  char *line = readline("test> ");
  if (!line || strcmp(line, "Pantry readline")) return 2;
  add_history(line);
  HIST_ENTRY *entry = history_get(1);
  int failed = !entry || strcmp(entry->line, line);
  free(line);
  clear_history();
  fclose(input);
  fclose(output);
  return failed;
}
PANTRY_C`,
      'cc -I"{{prefix}}/include" readline-consumer.c -L"{{prefix}}/lib" -Wl,-rpath,"{{prefix}}/lib" -lreadline -lhistory -o readline-consumer',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH ./readline-consumer',
    ],
  },
}
