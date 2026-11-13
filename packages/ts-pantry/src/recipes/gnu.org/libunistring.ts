import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'gnu.org/libunistring',
  name: 'libunistring',
  revisions: { '1.4.2': 1 },
  programs: [],
  dependencies: {
    darwin: {
      'gnu.org/libiconv': '^1.19.0.1',
    },
  },
  buildDependencies: {
    'gnu.org/gmp': '*',
    'gnu.org/m4': '*',
  },
  distributable: {
    url: 'https://ftp.gnu.org/gnu/libunistring/libunistring-{{version.raw}}.tar.gz',
    stripComponents: 1,
  },
  build: {
    script: [
      './configure --prefix={{ prefix }}',
      'make --jobs {{ hw.concurrency }} install',
    ],
  },
  test: {
    required: true,
    script: [
      `cat > unistring-consumer.c <<'PANTRY_C'
#include <unistr.h>
int main(void) {
  const uint8_t input[] = { 0xe2, 0x82, 0xac };
  ucs4_t codepoint = 0;
  int consumed = u8_mbtouc(&codepoint, input, sizeof(input));
  return consumed != 3 || codepoint != 0x20ac;
}
PANTRY_C`,
      'cc -I"{{prefix}}/include" unistring-consumer.c -L"{{prefix}}/lib" -Wl,-rpath,"{{prefix}}/lib" -lunistring -o unistring-consumer',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH ./unistring-consumer',
    ],
  },
}
