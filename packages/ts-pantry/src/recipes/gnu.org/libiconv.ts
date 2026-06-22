import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'gnu.org/libiconv',
  name: 'iconv',
  description: 'GNU charset conversion library and iconv program',
  homepage: 'https://www.gnu.org/software/libiconv/',
  programs: ['iconv'],
  // pkgx: linux needs libstdcxx at runtime.
  dependencies: {
    linux: {
      'gnu.org/gcc/libstdcxx': '14',
    },
  },
  versionSource: {
    type: 'url-pattern',
    // Tarballs are published with the marketing (major.minor) version.
    url: 'https://ftp.gnu.org/gnu/libiconv/libiconv-{{version.marketing}}.tar.gz',
    knownVersions: ['1.17.0', '1.18.0', '1.19.0'],
  },
  distributable: {
    // pkgx ships libiconv-{{version.marketing}}.tar.gz (e.g. 1.19, not 1.19.0).
    url: 'https://ftp.gnu.org/gnu/libiconv/libiconv-{{version.marketing}}.tar.gz',
    stripComponents: 1,
  },

  build: {
    script: [
      './configure $ARGS',
      'make --jobs {{hw.concurrency}}',
      'make install',
      // GNU libiconv exports only the PREFIXED `libiconv*` symbols. Many macOS
      // consumers (notably gettext/libintl, which curl bundles) reference the
      // UNprefixed `iconv`/`iconv_open`/`iconv_close` (the system-iconv ABI) and
      // abort at load against this lib with `dyld: Symbol not found: _iconv`.
      // Re-link the dylib from the static archive, adding the unprefixed symbols
      // as aliases of the prefixed ones (additive — prefixed symbols stay), and
      // preserving the install name + dylib versions so dependents still load it.
      // The alias can't go in plain LDFLAGS (it would break configure's compiler
      // test, which defines no _libiconv); doing it here on the finished lib is safe.
      {
        if: 'darwin',
        run: [
          'cd {{prefix}}/lib',
          'NAME=$(otool -D libiconv.2.dylib | tail -n1)',
          'VER=$(otool -l libiconv.2.dylib | awk \'/cmd LC_ID_DYLIB/{f=1} f && /current version/{print $3; exit}\')',
          'COMPAT=$(otool -l libiconv.2.dylib | awk \'/cmd LC_ID_DYLIB/{f=1} f && /compatibility version/{print $3; exit}\')',
          'clang -dynamiclib -fPIC -install_name "$NAME" -current_version "${VER:-9.1.0}" -compatibility_version "${COMPAT:-9.0.0}" -o libiconv.2.dylib.new -Wl,-force_load,libiconv.a -L. -lcharset -Wl,-alias,_libiconv,_iconv -Wl,-alias,_libiconv_open,_iconv_open -Wl,-alias,_libiconv_close,_iconv_close',
          'mv libiconv.2.dylib.new libiconv.2.dylib',
          'if [ -L libiconv.dylib ] || [ -f libiconv.dylib ]; then rm -f libiconv.dylib && ln -s libiconv.2.dylib libiconv.dylib; fi',
          'nm -gU libiconv.2.dylib | grep -qE " _iconv$" || { echo "ERROR: _iconv alias missing after relink"; exit 1; }',
        ],
      },
    ],
    env: {
      ARGS: [
        '--prefix={{prefix}}',
        '--disable-debug',
        '--disable-dependency-tracking',
        '--enable-extra-encodings',
        '--enable-static',
      ],
    },
  },

  test: {
    script: [
      'OUT=$(echo hello | iconv -f UTF-8 -t UTF-8)',
      'test "$OUT" = "hello"',
    ],
  },
}
