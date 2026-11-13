import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'tukaani.org/xz',
  name: 'xz',
  revisions: { '5.8.2': 1 },
  programs: [
    'lzcat',
    'lzcmp',
    'lzdiff',
    'lzegrep',
    'lzfgrep',
    'lzgrep',
    'lzless',
    'lzma',
    'lzmadec',
    'lzmainfo',
    'lzmore',
    'unlzma',
    'unxz',
    'xz',
    'xzcat',
    'xzcmp',
    'xzdec',
    'xzdiff',
    'xzegrep',
    'xzfgrep',
    'xzgrep',
    'xzless',
    'xzmore',
  ],
  dependencies: { darwin: { 'gnu.org/gettext': '*' } },
  buildDependencies: { 'gnu.org/make': '*', 'freedesktop.org/pkg-config': '*' },
  distributable: {
    url: 'https://github.com/tukaani-project/xz/releases/download/v{{version}}/xz-{{version}}.tar.xz',
    stripComponents: 1,
  },
  build: {
    script: [
      './configure $ARGS',
      'make --jobs {{ hw.concurrency }} install',
    ],
    env: {
      darwin: { MACOSX_DEPLOYMENT_TARGET: '14.0' },
      ARGS: [
        '--prefix={{ prefix }}',
        '--disable-debug',
        '--disable-doc',
      ],
    },
  },
  test: {
    required: true,
    script: [
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH "{{prefix}}/bin/xz" --version | grep -F "{{version}}"',
      'printf PantryNativeXZ > payload',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH "{{prefix}}/bin/xz" --keep payload',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH "{{prefix}}/bin/xz" --test payload.xz',
      'test "$(env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH "{{prefix}}/bin/xz" --decompress --stdout payload.xz)" = PantryNativeXZ',
      `cat > xz-consumer.c <<'PANTRY_C'
#include <lzma.h>
#include <string.h>
int main(void) {
  const uint8_t input[] = "Pantry native XZ API";
  uint8_t encoded[256], decoded[sizeof(input)];
  size_t encoded_size = 0, encoded_read = 0, decoded_size = 0;
  uint64_t memory_limit = UINT64_MAX;
  if (lzma_easy_buffer_encode(6, LZMA_CHECK_CRC64, 0, input, sizeof(input), encoded, &encoded_size, sizeof(encoded)) != LZMA_OK) return 1;
  if (lzma_stream_buffer_decode(&memory_limit, 0, 0, encoded, &encoded_read, encoded_size, decoded, &decoded_size, sizeof(decoded)) != LZMA_OK) return 2;
  return encoded_read != encoded_size || decoded_size != sizeof(input) || memcmp(input, decoded, sizeof(input)) != 0;
}
PANTRY_C`,
      'cc -I"{{prefix}}/include" xz-consumer.c -L"{{prefix}}/lib" -Wl,-rpath,"{{prefix}}/lib" -llzma -o xz-consumer',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH ./xz-consumer',
    ],
  },
}
