import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'zlib.net',
  name: 'zlib',
  revisions: { '1.3.2': 1 },
  description: 'A massively spiffy yet delicately unobtrusive compression library.',
  homepage: 'https://zlib.net/',
  github: 'https://github.com/madler/zlib',
  programs: [],
  versionSource: {
    type: 'github-releases',
    repo: 'madler/zlib',
  },
  distributable: {
    url: 'https://zlib.net/zlib-{{version.raw}}.tar.gz',
    stripComponents: 1,
  },

  build: {
    env: { darwin: { MACOSX_DEPLOYMENT_TARGET: '14.0' } },
    script: [
      './configure --prefix={{prefix}}',
      'make --jobs {{hw.concurrency}} install',
    ],
  },
  test: {
    required: true,
    script: [
      `cat > zlib-consumer.c <<'PANTRY_C'
#include <zlib.h>
#include <string.h>
int main(void) {
  const char input[] = "Pantry native zlib consumer";
  unsigned char compressed[128], restored[128];
  uLongf compressed_length = sizeof compressed, restored_length = sizeof restored;
  if (strcmp(zlibVersion(), ZLIB_VERSION)) return 1;
  if (compress2(compressed, &compressed_length, (const Bytef *)input, sizeof input, Z_BEST_COMPRESSION) != Z_OK) return 2;
  if (uncompress(restored, &restored_length, compressed, compressed_length) != Z_OK) return 3;
  return restored_length != sizeof input || memcmp(input, restored, sizeof input);
}
PANTRY_C`,
      'cc -I"{{prefix}}/include" zlib-consumer.c -L"{{prefix}}/lib" -Wl,-rpath,"{{prefix}}/lib" -lz -o zlib-consumer',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH ./zlib-consumer',
    ],
  },
}
