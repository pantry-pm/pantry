import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'open-mpi.org/hwloc',
  name: 'hwloc',
  revisions: { '2.13.0': 1 },
  revisionReasons: { '2.13.0': 'elf-loader-paths' },
  programs: [
    'hwloc-annotate',
    'hwloc-bind',
    'hwloc-calc',
    'hwloc-compress-dir',
    'hwloc-diff',
    'hwloc-distrib',
    'hwloc-info',
    'hwloc-patch',
    'hwloc-ps',
    'lstopo-no-graphics',
  ],
  dependencies: {
    // lstopo-no-graphics draws its text UI with ncursesw.
    'invisible-island.net/ncurses': '*',
  },
  buildDependencies: {
    'gnu.org/autoconf': '*',
    'gnu.org/libtool': '*',
  },
  distributable: {
    url: 'https://download.open-mpi.org/release/hwloc/v{{version.marketing}}/hwloc-{{version}}.tar.gz',
    stripComponents: 1,
  },
  build: {
    script: [
      './configure $ARGS',
      'make --jobs {{ hw.concurrency }} install',
    ],
    env: {
      ARGS: [
        '--prefix={{prefix}}',
        '--enable-shared',
        '--enable-static',
        '--disable-cairo',
        '--without-x',
        '--disable-cpuid',
        // Each of these is found on the build host and linked if present, and
        // none is a declared dependency: a consumer that bundles libhwloc is
        // then refused for libudev, libpciaccess and libxml2 it cannot name.
        '--disable-libudev',
        '--disable-pci',
        '--disable-libxml2',
      ],
      // Pantry's ncurses keeps terminfo in its own library (--with-termlib), so
      // -lncursesw alone fails hwloc's termcap probe; it then links -ltinfo and
      // lstopo-no-graphics misses wrefresh. Name both wide libraries up front.
      LIBS: '-lncursesw -ltinfow',
    },
  },
}
