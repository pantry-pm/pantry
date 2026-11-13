import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'gnu.org/libidn2',
  name: 'libidn2',
  // Preserve the accepted archive; the repaired build records library owners.
  revisions: { '2.3.8': 1 },
  programs: [
    'idn2',
  ],
  dependencies: {
    'gnu.org/gettext': '*',
    'gnu.org/libunistring': '^1',
  },
  buildDependencies: {
    'gnu.org/texinfo': '*',
    'freedesktop.org/pkg-config': '*',
  },
  distributable: {
    url: 'https://ftp.gnu.org/gnu/libidn/libidn2-{{ version.raw }}.tar.gz',
    stripComponents: 1,
  },
  build: {
    script: [
      './configure --prefix={{ prefix }}',
      'make install',
    ],
  },
  test: {
    required: true,
    script: [
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH {{prefix}}/bin/idn2 --version',
      `cat > idn2-consumer.c <<'PANTRY_C'
#include <idn2.h>
#include <stdint.h>
#include <string.h>
int main(void) {
  const uint8_t input[] = { 'b', 0xc3, 0xbc, 'c', 'h', 'e', 'r', '.', 'd', 'e', 0 };
  uint8_t *output = 0;
  int result = idn2_lookup_u8(input, &output, 0);
  if (result != IDN2_OK) return 1;
  int failed = strcmp((const char *)output, "xn--bcher-kva.de") != 0;
  idn2_free(output);
  return failed;
}
PANTRY_C`,
      'cc -I"{{prefix}}/include" idn2-consumer.c -L"{{prefix}}/lib" -Wl,-rpath,"{{prefix}}/lib" -lidn2 -o idn2-consumer',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH ./idn2-consumer',
    ],
  },
}
