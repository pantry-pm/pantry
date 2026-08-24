import type { Recipe } from '../../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'github.com/jbeder/yaml-cpp',
  name: 'yaml-cpp',
  programs: [],
  buildDependencies: {
    'cmake.org': '^3',
  },
  distributable: null,
  build: {
    script: [
      {
        run: 'VERSION={{version}}\nif [ "$VERSION" = "0.8.0" ]; then TAG="$VERSION"; else TAG="yaml-cpp-$VERSION"; fi\ncurl -Lfo src.tar.gz "https://github.com/jbeder/yaml-cpp/archive/refs/tags/${TAG}.tar.gz"\ntar xzf src.tar.gz --strip-components=1',
      },
      {
        run: 'mkdir -p build && cd build && cmake .. -DCMAKE_INSTALL_PREFIX={{prefix}} -DYAML_BUILD_SHARED_LIBS=ON -DYAML_CPP_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release && make --jobs {{hw.concurrency}} install',
        if: '<0.9',
      },
      {
        run: 'mkdir -p build && cd build && cmake .. -DCMAKE_INSTALL_PREFIX={{prefix}} -DYAML_BUILD_SHARED_LIBS=ON -DYAML_CPP_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release && cmake --build . && cmake --install .',
        if: '>=0.9',
      },
    ],
  },
  test: {
    script: [
      'c++ -std=c++11 -lyaml-cpp $FIXTURE',
      './a.out',
    ],
  },
}
