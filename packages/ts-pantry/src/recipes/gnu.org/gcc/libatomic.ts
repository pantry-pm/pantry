import type { Recipe } from '../../../../scripts/recipe-types'

/**
 * libatomic alone. Vendor binaries built with GCC link `libatomic.so.1` (the
 * official Node.js builds, and so the Node that Playwright carries), and the
 * only other provider is `gnu.org/gcc` itself: hundreds of megabytes of
 * compiler for one library of a few dozen kilobytes. `gnu.org/gcc/libstdcxx`
 * has libstdc++ and libgcc and nothing else.
 *
 * Linux only. On macOS the atomics are in the system runtime and nothing asks
 * for this library.
 */
export const recipe: Recipe = {
  domain: 'gnu.org/gcc/libatomic',
  name: 'libatomic',
  description: 'The GNU atomic operations runtime library (libatomic.so.1) on its own, without the compiler',
  homepage: 'https://gcc.gnu.org/wiki/Atomic',
  programs: [],
  platforms: ['linux/x86-64', 'linux/aarch64'],
  buildDependencies: {
    'gnu.org/gcc': '*',
    'gnu.org/make': '*',
  },
  distributable: {
    url: 'https://ftp.gnu.org/gnu/gcc/gcc-{{version.raw}}/gcc-{{version.raw}}.tar.xz',
    stripComponents: 1,
  },
  build: {
    script: [
      // The library's own configure, with the compiler that is already here:
      // the top-level tree would build a whole GCC first to compile it with.
      'cd libatomic',
      './configure --prefix="{{prefix}}" --libdir="{{prefix}}/lib" --disable-multilib --disable-static --disable-werror',
      'make --jobs {{hw.concurrency}}',
      'make install',
      // GCC installs target libraries under the compiler's multi-OS directory,
      // which is ../lib64 on x86-64 whatever --libdir says.
      'if [ -d "{{prefix}}/lib64" ] && [ ! -L "{{prefix}}/lib64" ]; then',
      '  mkdir -p "{{prefix}}/lib"',
      '  mv "{{prefix}}/lib64"/* "{{prefix}}/lib/"',
      '  rmdir "{{prefix}}/lib64"',
      'fi',
      'rm -f "{{prefix}}/lib"/*.la',
      'test -e "{{prefix}}/lib/libatomic.so.1"',
    ],
  },
  test: {
    required: true,
    script: [
      'test -e "{{prefix}}/lib/libatomic.so.1"',
    ],
  },
}
