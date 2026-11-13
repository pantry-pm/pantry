import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  propsDir: '../props/facebook.com/zstd',
  domain: 'facebook.com/zstd',
  name: 'zstd',
  revisions: { '1.5.7': 2 },
  programs: [
    'pzstd',
    'unzstd',
    'zstd',
    'zstdcat',
    'zstdgrep',
    'zstdless',
    'zstdmt',
  ],
  dependencies: {
    'lz4.org': '^1',
    'tukaani.org/xz': '^5.8.2.1',
    'zlib.net': '^1',
  },
  buildDependencies: {
    'cmake.org': '^3',
    'ninja-build.org': '^1',
    'gnu.org/patch': '*',
  },
  distributable: {
    url: 'https://github.com/meta/zstd/archive/v{{version}}.tar.gz',
    stripComponents: 1,
  },
  build: {
    script: [
      // Source backport for meta/zstd#4897; retain every compression format.
      { run: 'patch --batch --fuzz=0 -p1 < props/lz4-canonical-checksum.patch', if: '=1.5.7' },
      'cmake build/cmake $ARGS',
      'cmake --build .',
      'cmake --install .',
      {
        run: 'install_name_tool -add_rpath @loader_path/../lib pzstd\ninstall_name_tool -add_rpath @loader_path/../lib zstd\n',
        if: 'darwin',
        'working-directory': '${{prefix}}/bin',
      },
    ],
    env: {
      ARGS: [
        '-GNinja',
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_INSTALL_PREFIX={{prefix}}',
        '-DZSTD_PROGRAMS_LINK_SHARED=ON',
        '-DZSTD_BUILD_CONTRIB=ON',
        '-DZSTD_LEGACY_SUPPORT=ON',
        '-DZSTD_ZLIB_SUPPORT=ON',
        '-DZSTD_LZMA_SUPPORT=ON',
        '-DZSTD_LZ4_SUPPORT=ON',
      ],
      darwin: {
        MACOSX_DEPLOYMENT_TARGET: '14.0',
        ARGS: [
          '-DCMAKE_CXX_FLAGS=-std=c++11',
        ],
      },
    },
  },
  test: {
    required: true,
    script: [
      'STRING=PantryNativeZstd',
      'test "$(printf %s "$STRING" | "{{prefix}}/bin/zstd" | "{{prefix}}/bin/zstd" -d)" = "$STRING"',
      'test "$(printf %s "$STRING" | "{{prefix}}/bin/pzstd" | "{{prefix}}/bin/zstd" -d)" = "$STRING"',
      'test "$(printf %s "$STRING" | xz | "{{prefix}}/bin/zstd" -d)" = "$STRING"',
      'test "$(printf %s "$STRING" | lz4 | "{{prefix}}/bin/zstd" -d)" = "$STRING"',
      'test "$(printf %s "$STRING" | gzip | "{{prefix}}/bin/zstd" -d)" = "$STRING"',
      `cat > zstd-consumer.c <<'PANTRY_C'
#include <zstd.h>
#include <string.h>
int main(void) {
  const char input[] = "Pantry native Zstd API";
  char encoded[256], decoded[sizeof(input)];
  if (ZSTD_versionNumber() != ZSTD_VERSION_NUMBER) return 1;
  size_t encoded_size = ZSTD_compress(encoded, sizeof(encoded), input, sizeof(input), 1);
  if (ZSTD_isError(encoded_size)) return 2;
  size_t decoded_size = ZSTD_decompress(decoded, sizeof(decoded), encoded, encoded_size);
  return ZSTD_isError(decoded_size) || decoded_size != sizeof(input) || memcmp(input, decoded, sizeof(input)) != 0;
}
PANTRY_C`,
      'cc -I"{{prefix}}/include" zstd-consumer.c -L"{{prefix}}/lib" -Wl,-rpath,"{{prefix}}/lib" -lzstd -o zstd-consumer',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH ./zstd-consumer',
    ],
  },
}
