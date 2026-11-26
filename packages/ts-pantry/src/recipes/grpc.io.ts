import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'grpc.io',
  name: 'grpc',
  description: 'The C based gRPC (C++, Python, Ruby, Objective-C, PHP, C#)',
  homepage: 'https://grpc.io/',
  github: 'https://github.com/grpc/grpc',
  programs: ['grpc_csharp_plugin', 'grpc_node_plugin', 'grpc_cpp_plugin', 'grpc_python_plugin', 'grpc_objective_c_plugin', 'grpc_ruby_plugin', 'grpc_php_plugin'],
  // grpc_cli is only built on darwin (see the build script); declaring it for
  // linux fails the declared-program check on an artifact that never has it.
  platformPrograms: { darwin: ['grpc_cli'] },
  versionSource: {
    type: 'github-releases',
    repo: 'grpc/grpc',
  },
  distributable: {
    url: 'git+https://github.com/grpc/grpc',
    // Check out the requested release tag so submodules/build match {{version}}.
    // downloadSource() forwards this as `git clone --branch <ref> --single-branch`.
    ref: 'v{{version}}',
  },
  dependencies: {
    'c-ares.org': '*',
    'openssl.org': '^1.1',
    'github.com/google/re2': '*',
    'zlib.net': '*',
    'darwin': {
      // darwin publishes pkgx's prebuilt where pkgx ships one, and pkgx links
      // grpc 1.85 against the abseil 20260526 LTS line
      // (@rpath/abseil.io/v20260526/lib/...). Declaring 20250512 left those
      // libraries without a provider. protobuf is built in-tree here.
      'abseil.io': '^20260526',
    },
    'linux': {
      // grpc vendors the abseil 20250512 LTS line (third_party/abseil-cpp submodule +
      // bazel/grpc_deps.bzl), so build against that line. Bound it by line, not by
      // patch: only the newest patch of an LTS line is published (20250512.2), and
      // an exact `20250512.1` pin has no binary on any platform, which fails
      // dependency resolution before the build starts. Patch releases of one LTS
      // line share the same inline namespace and SONAME, so they are ABI-equal.
      'abseil.io': '^20250512',
      'gnu.org/gcc/libstdcxx': '14',
      // linux links the packaged protobuf (gRPC_PROTOBUF_PROVIDER=package).
      // This is a floor, not a pin: protobuf 30.0.0 was never published, and
      // the working linux builds linked the newest published protobuf.
      'protobuf.dev': '>=30',
    },
  },
  buildDependencies: {
    'gnu.org/autoconf': '*',
    'gnu.org/automake': '*',
    'gnu.org/libtool': '*',
    'cmake.org': '^3',
    'git-scm.org': '^2',
    // darwin needs GNU patch to apply the CMakeLists fix
    'darwin': {
      'gnu.org/patch': '*',
    },
  },

  build: {
    'working-directory': 'cmake/build',
    script: [
      // distributable.ref already checked out the release tag; just init submodules.
      {
        run: 'git submodule update --init --recursive',
        'working-directory': '../..',
      },

      // darwin link fix: https://github.com/grpc/grpc/issues/36654
      {
        run: 'if test {{hw.platform}} = "darwin"; then\n  patch -i $PROP || true\nfi',
        if: '>=1.63<1.66.2',
        'working-directory': '../..',
        prop: {
          content: [
            '--- CMakeLists.txt.orig\t2024-05-16 01:01:03.000000000 +0000',
            '+++ CMakeLists.txt',
            '@@ -3682,6 +3682,7 @@ target_include_directories(upb_json_lib',
            ' )',
            ' target_link_libraries(upb_json_lib',
            '   ${_gRPC_ALLTARGETS_LIBRARIES}',
            '+  grpc++_unsecure',
            '   utf8_range_lib',
            '   upb_message_lib',
            ' )',
            '@@ -3883,6 +3884,7 @@ target_include_directories(upb_textforma',
            ' )',
            ' target_link_libraries(upb_textformat_lib',
            '   ${_gRPC_ALLTARGETS_LIBRARIES}',
            '+  grpc++_unsecure',
            '   utf8_range_lib',
            '   upb_message_lib',
            ' )',
            '',
          ].join('\n'),
        },
      },

      'cmake $COMMON_ARGS $ARGS ../..',
      'make install',

      // Build the cli — fails to build on linux, so darwin-only.
      {
        run: [
          'cmake $COMMON_ARGS $CLI_ARGS ../..',
          'make grpc_cli',
          'cp grpc_cli {{prefix}}/bin',
          'cp libgrpc++_test_config.* {{prefix}}/lib',
        ],
        if: 'darwin',
      },

      // grpc libs/binaries reference @rpath/libgrpc_plugin_support.*.dylib, so
      // add @loader_path to the rpath.
      {
        run: 'for f in bin/* lib/libgrpc++_test_config.dylib; do\n  if test -f $f && ! otool -l $f | grep @loader_path/../lib; then\n    install_name_tool -add_rpath @loader_path/../lib $f\n  fi\ndone',
        if: 'darwin',
        'working-directory': '{{prefix}}',
      },
    ],
    env: {
      COMMON_ARGS: ['-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_INSTALL_PREFIX={{prefix}}', '-DCMAKE_INSTALL_RPATH={{prefix}}', '-DBUILD_SHARED_LIBS=ON'],
      ARGS: ['-DCMAKE_CXX_STANDARD=17', '-DCMAKE_CXX_STANDARD_REQUIRED=TRUE', '-DgRPC_BUILD_TESTS=OFF', '-DgRPC_INSTALL=ON', '-DgRPC_ABSL_PROVIDER=package', '-DgRPC_CARES_PROVIDER=package', '-DgRPC_SSL_PROVIDER=package', '-DgRPC_ZLIB_PROVIDER=package', '-DgRPC_RE2_PROVIDER=package'],
      CLI_ARGS: ['-DgRPC_BUILD_TESTS=ON'],
      darwin: {
        ARGS: ['-DgRPC_PROTOBUF_PROVIDER=module', '-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-rpath,{{pkgx.prefix}},-undefined,dynamic_lookup'],
      },
      linux: {
        // linker complains about libstdc++ symbols, but they resolve at runtime
        ARGS: ['-DgRPC_PROTOBUF_PROVIDER=package', '-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-labsl_log_internal_message,-lstdc++,--allow-shlib-undefined', '-DCMAKE_EXE_LINKER_FLAGS=-Wl,-labsl_log_internal_message,-lstdc++,--allow-shlib-undefined'],
      },
    },
  },
}
