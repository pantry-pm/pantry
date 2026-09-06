import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'doxygen.nl',
  name: 'doxygen',
  description: 'Generate documentation for several programming languages',
  homepage: 'https://www.doxygen.nl/',
  github: 'https://github.com/doxygen/doxygen',
  programs: ['doxygen'],
  versionSource: {
    type: 'github-releases',
    repo: 'doxygen/doxygen',
    tagPattern: /^Release_(\d+)_(\d+)_(\d+)$/,
  },
  distributable: {
    url: 'https://github.com/doxygen/doxygen/archive/refs/tags/Release_{{version.major}}_{{version.minor}}_{{version.patch}}.tar.gz',
    stripComponents: 1,
  },
  buildDependencies: {
    'gnu.org/bison': '^3',
    'cmake.org': '^3',
    'github.com/westes/flex': '2',
    'python.org': '>=3<3.12',
    'linux': {
      'llvm.org': '20',
    },
  },

  build: {
    workingDirectory: 'build',
    script: [
      // macOS ships an ancient system bison (2.3); doxygen's CMake needs >= 2.7.
      // The `gnu.org/bison` buildDependency above (3.8.2) provides a modern bison
      // on PATH for the build, so CMake's find_package(BISON) picks it up — no
      // Homebrew needed. Linux uses apt-installed bison 3.x just the same.
      'cmake $ARGS -G "Unix Makefiles" ..',
      'make --jobs {{hw.concurrency}}',
      'make install',
    ],
    env: {
      'ARGS': ['-DCMAKE_INSTALL_PREFIX={{prefix}}', '-DCMAKE_BUILD_TYPE=Release'],
    },
  },
}
