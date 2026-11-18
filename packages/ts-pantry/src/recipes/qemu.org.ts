import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'qemu.org',
  name: 'qemu',
  description: 'Generic machine emulator and virtualizer',
  homepage: 'https://www.qemu.org/',
  programs: ['qemu-img', 'qemu-edid', 'qemu-io', 'qemu-nbd', 'qemu-storage-daemon', 'qemu-system-aarch64', 'qemu-system-alpha', 'qemu-system-arm', 'qemu-system-avr', 'qemu-system-hppa', 'qemu-system-i386', 'qemu-system-loongarch64', 'qemu-system-m68k', 'qemu-system-microblaze', 'qemu-system-microblazeel', 'qemu-system-mips', 'qemu-system-mips64', 'qemu-system-mips64el', 'qemu-system-mipsel', 'qemu-system-or1k', 'qemu-system-ppc', 'qemu-system-ppc64', 'qemu-system-riscv32', 'qemu-system-riscv64', 'qemu-system-rx', 'qemu-system-s390x', 'qemu-system-sh4', 'qemu-system-sh4eb', 'qemu-system-sparc', 'qemu-system-sparc64', 'qemu-system-tricore', 'qemu-system-x86_64', 'qemu-system-xtensa', 'qemu-system-xtensaeb'],
  distributable: {
    url: 'https://download.qemu.org/qemu-{{version}}.tar.xz',
    stripComponents: 1,
  },
  dependencies: {
    'gnome.org/glib': '2',
    // capstone 4.0.2's published headers live only under include/capstone/,
    // so qemu's `#include <capstone.h>` probe fails; 5.x also installs it at
    // include/. qemu accepts capstone >= 3.0.5.
    'capstone-engine.org': '^5',
    'pixman.org': '^0',
    'gnutls.org': '^3',
    'freedesktop.org/slirp': '^4',
    'virtualsquare.org/vde': '^2',
    'facebook.com/zstd': '^1',
    'invisible-island.net/ncurses': '^6',
    'libssh.org': '^0',
    'libpng.org': '^1',
  },
  buildDependencies: {
    'gnu.org/bison': '*',
    'github.com/westes/flex': '*',
    'python.org': '~3.11',
    'ninja-build.org': '*',
    'mesonbuild.com': '*',
  },

  build: {
    script: [
      // TODO: linux virtfs <8 requires attr and libcap-ng
      { run: 'ARGS="$ARGS --enable-virtfs"', if: '>=8' },

      // https://gitlab.com/qemu-project/qemu/-/issues/1853
      { run: 'sed -i -e"s/-isystem\', /-isystem\' + /g" meson.build', if: '>=8.1.4' },

      // The macOS 27 SDK obsoletes PGNewDeviceWithDescriptor (removed from the
      // ParavirtualizedGraphics stub; replacement available from macOS 15.2),
      // so apple-gfx.m fails to link with "Undefined symbols:
      // _PGNewDeviceWithDescriptor". apple-gfx.m uses manual retain/release,
      // where both functions return a +1 object, so the rename is exact. It
      // needs macOS 15.2, below the 15.7+ floor our darwin dependencies carry,
      // so no recipe-level MACOSX_DEPLOYMENT_TARGET: one lower than those
      // dependencies fails runtime qualification.
      { run: 'test ! -f hw/display/apple-gfx.m || sed -i -e "s/PGNewDeviceWithDescriptor/PGCreateDeviceWithDescriptor/g" hw/display/apple-gfx.m', if: 'darwin' },

      './configure $ARGS',
      'make --jobs {{hw.concurrency}} install',

      // Without this, `codesign` complains about resource forks in the binary
      { run: 'xattr -cr {{prefix}}/bin/*', if: 'darwin' },
    ],
    env: {
      'ARGS': ['--prefix={{prefix}}', '--disable-bsd-user', '--disable-guest-agent', '--enable-slirp', '--enable-capstone', '--enable-curses', '--enable-libssh', '--enable-vde', '--enable-zstd', '--extra-cflags=-DNCURSES_WIDECHAR=1', '--disable-sdl', '--disable-docs'],
      'darwin': {
        ARGS: ['--enable-virtfs'],
      },
    },
  },
}
