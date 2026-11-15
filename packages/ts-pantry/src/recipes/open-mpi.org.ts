import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'open-mpi.org',
  name: 'open-mpi',
  description: 'Open MPI main development repository',
  homepage: 'https://www.open-mpi.org',
  github: 'https://github.com/open-mpi/ompi',
  programs: ['mpic++', 'mpiCC', 'mpicc', 'mpicxx', 'mpiexec', 'mpif77', 'mpif90', 'mpifort', 'mpirun', 'ompi_info', 'opal_wrapper'],
  platforms: ['linux', 'darwin/aarch64'], // fortran not happy on increasingly ancient darwin/x86-64
  versionSource: {
    type: 'github-tags',
    repo: 'open-mpi/ompi',
    // Final releases only. `v(.+)` also took `v6.0.0rc3` and `v5.0.9amzn1`:
    // release candidates then filled every build slot ahead of the newest
    // stable, and the 6.0 candidates cannot configure at all (their PRRTE
    // wants PMIx 7, newer than any openpmix release).
    tagPattern: /^v(\d+\.\d+\.\d+)$/,
  },
  distributable: {
    url: 'https://download.open-mpi.org/release/open-mpi/v{{version.marketing}}/openmpi-{{version}}.tar.bz2',
    stripComponents: 1,
  },
  dependencies: {
    'open-mpi.org/hwloc': '*',
    'openpmix.github.io': '5',
    'libevent.org': '*',
    // The Fortran bindings (libmpi_mpifh, libmpi_usempif08, ...) load
    // libgfortran.so.5 and libquadmath.so.0, and mpifort drives gfortran.
    // pkgx lists gcc as a companion; here a loaded library needs a declared
    // runtime provider or the artifact is refused at publication.
    'gnu.org/gcc': '*',
  },
  buildDependencies: {
    'zlib.net': '^1',
    'python.org': '^3',
    // needed for gfortran
    'gnu.org/binutils': '*',
    'gnu.org/gcc': '*',
  },

  build: {
    script: [
      {
        run: 'rm -rf hwloc* libevent* openpmix*',
        'working-directory': '3rd-party',
      },
      './configure $CONFIGURE_ARGS',
      'make --jobs {{hw.concurrency}} all',
      'make --jobs {{hw.concurrency}} install',
      {
        run: 'sed -i "s|linker_flags=.*|linker_flags=|g" *-wrapper-data.txt',
        'working-directory': '{{prefix}}/share/openmpi',
      },
      // Only copy Fortran .mod files if the build actually produced any —
      // a bare `install {{prefix}}/lib/*.mod` aborts with "cannot stat '*.mod'"
      // when the glob matches nothing (e.g. no gfortran modules emitted).
      'for _m in {{prefix}}/lib/*.mod; do [ -e "$_m" ] && install "$_m" {{prefix}}/include/ || true; done',
    ],
    env: {
      CXXFLAGS: ['-std=c++11'],
      darwin: {
        // prevent gcc from taking over
        CC: 'clang',
        CXX: 'clang++',
        LD: '/usr/bin/ld',
        CFLAGS: [
          '-Wl,-rpath,{{prefix}},-headerpad_max_install_names',
          '-Wno-unused-command-line-argument',
        ],
        CXXFLAGS: [
          '-Wl,-rpath,{{prefix}},-headerpad_max_install_names',
          '-Wno-unused-command-line-argument',
        ],
        FCFLAGS: [
          '-Wl,-rpath,{{prefix}},-headerpad_max_install_names',
          '-Wno-unused-command-line-argument',
        ],
        LDFLAGS: [
          '-Wl,-headerpad_max_install_names',
          '-Wno-unused-command-line-argument',
        ],
      },
      CONFIGURE_ARGS: [
        '--disable-debug',
        '--disable-dependency-tracking',
        '--prefix={{prefix}}',
        '--libdir={{prefix}}/lib',
        '--disable-silent-rules',
        '--enable-ipv6',
        '--enable-mca-no-build=reachable-netlink',
        '--sysconfdir={{prefix}}/etc',
        '--with-libevent={{deps.libevent.org.prefix}}',
        '--with-hwloc={{deps.open-mpi.org/hwloc.prefix}}',
        '--with-pmix={{deps.openpmix.github.io.prefix}}',
        '--with-sge',
        '--disable-dlopen',
      ],
    },
  },
}
