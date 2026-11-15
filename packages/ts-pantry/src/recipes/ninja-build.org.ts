import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'ninja-build.org',
  name: 'ninja',
  description: 'Small build system for use with gyp or CMake',
  homepage: 'https://ninja-build.org/',
  github: 'https://github.com/ninja-build/ninja',
  programs: ['ninja'],
  versionSource: {
    type: 'github-releases',
    repo: 'ninja-build/ninja',
    tagPattern: /^v(.+)$/,
  },
  distributable: {
    url: 'https://github.com/ninja-build/ninja/archive/refs/tags/v{{version}}.tar.gz',
    stripComponents: 1,
  },

  build: {
    script: [
      'cmake -Bbuild-cmake -DCMAKE_INSTALL_PREFIX={{prefix}} -DCMAKE_BUILD_TYPE=Release',
      'cmake --build build-cmake --parallel {{hw.concurrency}}',
      'cmake --install build-cmake',
      // 1.10.0 has the CMake build but no install() rule (added in 1.10.1), so
      // `cmake --install` succeeds and installs nothing.
      {
        run: [
          'mkdir -p {{prefix}}/bin',
          'install -m 755 build-cmake/ninja {{prefix}}/bin/ninja',
        ],
        if: '<1.10.1',
      },
    ],
  },
}
