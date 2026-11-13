import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'llvm.org',
  name: 'llvm',
  description: 'The LLVM Project is a collection of modular and reusable compiler and toolchain technologies.',
  homepage: 'https://llvm.org',
  github: 'https://github.com/llvm/llvm-project',
  programs: ['lld', 'clang', 'clang++', 'cc', 'c++', 'cpp', 'nm', 'objcopy', 'ranlib', 'readelf', 'strings', 'strip', 'llvm-profdata', 'llvm-cov'],
  versionSource: {
    type: 'github-releases',
    repo: 'llvm/llvm-project',
    tagPattern: /^llvmorg-(.+)$/,
  },
  distributable: {
    url: 'https://github.com/llvm/llvm-project/releases/download/llvmorg-{{version}}/llvm-project-{{version}}.src.tar.xz',
    stripComponents: 1,
  },
  dependencies: {
    'zlib.net': '1',
    'facebook.com/zstd': '*',
  },
  buildDependencies: {
    'cmake.org': '>=3<3.29',
    'ninja-build.org': '1',
    'python.org': '>=3<3.12',
    'crates.io/semverator': '*',
  },

  build: {
    'working-directory': 'build',
    script: [
      'RUNTIMES="-DLLVM_ENABLE_RUNTIMES=\'compiler-rt\'"',
      'if test {{hw.platform}} = "linux"; then',
      '  ARGS="$ARGS $RUNTIMES"',
      'elif semverator satisfies \'>=14\' {{version}}; then',
      '  ARGS="$ARGS $RUNTIMES"',
      'elif test {{hw.arch}} = "x86-64" && semverator satisfies \'>=14\' {{version}}; then',
      '  ARGS="$ARGS $RUNTIMES"',
      'fi',
      '',
      'cmake ../llvm -G Ninja $ARGS',
      'ninja',
      'ninja install',
      'cd "${{prefix}}/bin"',
      'ln -sf clang cc',
      'ln -sf clang++ c++',
      'ln -sf clang-cpp cpp',
      'for x in nm objcopy ranlib readelf strings strip; do',
      '  ln -sf llvm-$x $x',
      'done',
      '',
      'cd "${{prefix}}/lib"',
      'TARGET="$(find . -maxdepth 1 -type d -name \\*-unknown-linux-gnu)"',
      'if test -n "$TARGET"; then',
      '  mv "$TARGET"/* .',
      '  rmdir "$TARGET"',
      '  ln -s . "$TARGET"',
      'fi',
      '',
    ],
    env: {
      'ARGS': ['-DCMAKE_INSTALL_PREFIX={{prefix}}', '-DCMAKE_BUILD_TYPE=Release', '-DLLVM_ENABLE_PROJECTS=\'lld;lldb;clang;clang-tools-extra\'', '-DLLVM_INCLUDE_DOCS=OFF', '-DLLVM_INCLUDE_TESTS=OFF', '-DLLVM_ENABLE_RTTI=ON', '-DLLVM_BUILD_LLVM_DYLIB=ON'],
      darwin: {
        MACOSX_DEPLOYMENT_TARGET: '14.0',
      },
    },
  },
  test: {
    required: true,
    script: [
      '"{{prefix}}/bin/clang" --version',
      '"{{prefix}}/bin/clang++" --version',
      `cat > compiler-consumer.cpp <<'PANTRY_CPP'
#include <cstdio>
#include <vector>
int main() {
  std::vector<int> values(3, 14);
  if (values[0] + values[1] + values[2] != 42) return 1;
  std::puts("PANTRY_LLVM_COMPILER_OK");
}
PANTRY_CPP`,
      '"{{prefix}}/bin/clang++" compiler-consumer.cpp -o compiler-consumer',
      'test "$(env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH ./compiler-consumer)" = PANTRY_LLVM_COMPILER_OK',
      // Darwin builds before LLVM 14 do not include compiler-rt in this recipe.
      'if test {{version.major}} -ge 14; then',
      '  "{{prefix}}/bin/clang++" -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all compiler-consumer.cpp -o sanitized-consumer',
      '  test "$(env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH ./sanitized-consumer)" = PANTRY_LLVM_COMPILER_OK',
      `  cat > sanitizer-detection.c <<'PANTRY_C'
#include <stdlib.h>
int main(void) {
  volatile int *value = (int *)malloc(sizeof(int));
  if (!value) return 2;
  *value = 42;
  free((void *)value);
  return *value;
}
PANTRY_C`,
      '  "{{prefix}}/bin/clang" -O1 -g -fsanitize=address -fno-sanitize-recover=all sanitizer-detection.c -o sanitizer-detection',
      '  if env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH ./sanitizer-detection >sanitizer-detection.log 2>&1; then',
      '    cat sanitizer-detection.log',
      '    echo "LLVM AddressSanitizer did not reject a heap use after free" >&2',
      '    exit 1',
      '  fi',
      '  cat sanitizer-detection.log',
      '  grep -F "AddressSanitizer: heap-use-after-free" sanitizer-detection.log',
      'fi',
    ],
  },
}
