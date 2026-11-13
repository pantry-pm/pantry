import type { Recipe } from '../../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'github.com/google/brotli',
  name: 'brotli',
  revisions: { '1.2.0': 1 },
  programs: [
    'brotli',
  ],
  buildDependencies: {
    'cmake.org': '*',
  },
  distributable: {
    url: 'https://github.com/google/brotli/archive/v{{version}}.tar.gz',
    stripComponents: 1,
  },
  build: {
    env: { darwin: { MACOSX_DEPLOYMENT_TARGET: '14.0' } },
    'working-directory': 'build',
    script: [
      'cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX={{prefix}}',
      'make --jobs={{ hw.concurrency }}',
      'make install',
    ],
  },
  test: {
    required: true,
    script: [
      'printf PantryNativeBrotli > payload',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH "{{prefix}}/bin/brotli" --output=payload.br payload',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH "{{prefix}}/bin/brotli" --output=decoded --decompress payload.br',
      'test "$(cat decoded)" = PantryNativeBrotli',
      `cat > brotli-consumer.c <<'PANTRY_C'
#include <brotli/encode.h>
#include <brotli/decode.h>
#include <string.h>
int main(void) {
  const unsigned char input[] = "Pantry native Brotli API";
  unsigned char encoded[256], decoded[sizeof(input)];
  size_t encoded_size = sizeof(encoded), decoded_size = sizeof(decoded);
  if (!BrotliEncoderCompress(BROTLI_DEFAULT_QUALITY, BROTLI_DEFAULT_WINDOW, BROTLI_MODE_GENERIC, sizeof(input), input, &encoded_size, encoded)) return 1;
  if (BrotliDecoderDecompress(encoded_size, encoded, &decoded_size, decoded) != BROTLI_DECODER_RESULT_SUCCESS) return 2;
  return decoded_size != sizeof(input) || memcmp(input, decoded, sizeof(input)) != 0;
}
PANTRY_C`,
      'cc -I"{{prefix}}/include" brotli-consumer.c -L"{{prefix}}/lib" -Wl,-rpath,"{{prefix}}/lib" -lbrotlienc -lbrotlidec -lbrotlicommon -o brotli-consumer',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH ./brotli-consumer',
    ],
  },
}
