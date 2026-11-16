import type { Recipe } from '../../../scripts/recipe-types'

/** The GBM client ABI is independent of Mesa's renderer and compiler drivers. */
export const recipe: Recipe = {
  domain: 'mesa3d.org/libgbm',
  name: 'libgbm',
  description: 'Mesa Generic Buffer Management client library',
  homepage: 'https://www.mesa3d.org/',
  platforms: ['linux'],
  programs: [],
  versionSource: { type: 'url-pattern', url: 'https://archive.mesa3d.org/mesa-{{version}}.tar.xz', knownVersions: ['26.0.6'] },
  distributable: { url: 'https://archive.mesa3d.org/mesa-{{version}}.tar.xz', stripComponents: 1 },
  dependencies: {
    'dri.freedesktop.org': '^2.4.110',
    'libexpat.github.io': '^2',
    'systemd.io/libudev': '^262',
  },
  buildDependencies: {
    'python.org': '~3.11',
    'ninja-build.org': '*',
    'freedesktop.org/pkg-config': '^0.29',
    'gnu.org/coreutils': '*',
    'gnu.org/binutils': '*',
    'bun.com': '^1.3',
  },
  propsDir: '../props/mesa3d.org/libgbm',
  publish: { include: ['lib/libgbm.so*', 'lib/pkgconfig/gbm.pc', 'include/gbm*.h', 'share/licenses/**'] },
  build: {
    script: [
      'python -m venv .build-python',
      '.build-python/bin/python -m pip install --only-binary=:all: --require-hashes --no-cache-dir -r "{{srcroot}}/props/requirements.txt"',
      'export PATH="$PWD/.build-python/bin:$PATH"',
      'meson setup build --prefix={{prefix}} --libdir=lib --buildtype=release --wrap-mode=nofallback -Dauto_features=disabled "-Dplatforms=[]" "-Dgallium-drivers=[]" "-Dvulkan-drivers=[]" -Dopengl=false -Dgles1=disabled -Dgles2=disabled -Dglx=disabled -Degl=disabled -Dgbm=enabled -Dllvm=disabled -Dbuild-tests=false "-Dtools=[]"',
      'ninja -C build -j{{hw.concurrency}}',
      'ninja -C build install',
      'install -Dm644 docs/license.rst "{{prefix}}/share/licenses/libgbm/license.rst"',
    ],
  },
  test: {
    required: true,
    script: [
      'pkg-config --exists gbm',
      'readelf --dynamic "{{prefix}}/lib/libgbm.so.1" > gbm-needed.txt',
      '! grep -Ei "libLLVM|gallium" gbm-needed.txt',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH bun -e \'import { dlopen, FFIType, ptr } from "bun:ffi"; const lib = dlopen("{{prefix}}/lib/libgbm.so.1", { gbm_format_get_name: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.cstring } }); const name = new Uint8Array(5); if (String(lib.symbols.gbm_format_get_name(0x34325258, ptr(name))) !== "XR24") throw new Error("GBM client ABI failed"); lib.close(); console.log("GBM_CLIENT_OK")\'',
    ],
  },
}
