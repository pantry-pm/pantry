import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'curl.se',
  name: 'cURL',
  description: 'A command line tool and library for transferring data with URL syntax, supporting DICT, FILE, FTP, FTPS, GOPHER, GOPHERS, HTTP, HTTPS, IMAP, IMAPS, LDAP, LDAPS, MQTT, POP3, POP3S, RTMP, RTMPS, RTSP, SCP, SFTP, SMB, SMBS, SMTP, SMTPS, TELNET, TFTP, WS and WSS. libcurl offers a myriad of powerful features',
  homepage: 'https://curl.se',
  github: 'https://github.com/curl/curl',
  programs: ['curl', 'curl-config'],
  versionSource: {
    type: 'github-releases',
    repo: 'curl/curl',
    tagPattern: /^curl-(\d+)_(\d+)_(\d+)$/,
  },
  distributable: {
    url: 'https://curl.se/download/curl-{{version}}.tar.bz2',
    stripComponents: 1,
  },
  dependencies: {
    'openssl.org': '^3',
    'curl.se/ca-certs': '*',
    'zlib.net': '^1.2.11',
    'nghttp2.org': '*',
    // Everything the SHIPPED libcurl.pc names in Requires.private, so a
    // downstream `pkg-config libcurl` can resolve. Read off the published
    // 8.22.0 linux-x86-64 artifact rather than guessed:
    //
    //   Requires.private: libidn2,zlib,libbrotlidec,libbrotlicommon,libzstd,
    //                     openssl,libnghttp2
    //
    // configure links whatever it finds on the build host and records it there,
    // so an undeclared one is invisible until some other package asks
    // pkg-config for libcurl. php.net failed first on libidn2 and then, once
    // that was declared, on libbrotlidec — one at a time, because the list was
    // never read in full.
    'gnu.org/libidn2': '*',
    'github.com/google/brotli': '*',
    'facebook.com/zstd': '*',
  },

  build: {
    script: [
      './configure $ARGS',
      'make --jobs {{hw.concurrency}} install',
      {
        // Everything libcurl.so records as NEEDED has to travel with it.
        //
        // The published 8.22.0 artifact does not: `readelf -d` on its
        // libcurl.so.4.8.0 names libbrotlidec.so.1, libidn2.so.0 and
        // libzstd.so.1, none of which is in the tarball. configure links
        // whatever it finds on the build host, and only the four below were
        // ever copied — so the artifact referenced three libraries it neither
        // shipped nor declared. php.net's configure got as far as
        // "checking for libcurl >= 7.61.0... yes" and then failed at
        // "curl_easy_perform in -lcurl... no", because the linker could not
        // follow that chain.
        //
        // Globbed by soname rather than pinned to an exact minor: the versions
        // above were already stale spellings waiting to break on a dep bump.
        run: [
          'cp -L {{deps.openssl.org.prefix}}/lib/libssl.so.3 {{prefix}}/lib/',
          'cp -L {{deps.openssl.org.prefix}}/lib/libcrypto.so.3 {{prefix}}/lib/',
          'cp -L {{deps.zlib.net.prefix}}/lib/libz.so.1 {{prefix}}/lib/',
          'cp -L {{deps.nghttp2.org.prefix}}/lib/libnghttp2.so.14 {{prefix}}/lib/',
          'cp -L {{deps.gnu.org/libidn2.prefix}}/lib/libidn2.so.[0-9] {{prefix}}/lib/ 2>/dev/null || true',
          'cp -L {{deps.github.com/google/brotli.prefix}}/lib/libbrotlidec.so.[0-9] {{prefix}}/lib/ 2>/dev/null || true',
          'cp -L {{deps.github.com/google/brotli.prefix}}/lib/libbrotlicommon.so.[0-9] {{prefix}}/lib/ 2>/dev/null || true',
          'cp -L {{deps.facebook.com/zstd.prefix}}/lib/libzstd.so.[0-9] {{prefix}}/lib/ 2>/dev/null || true',
          // Fail loudly if anything libcurl needs is still missing, rather than
          // shipping an artifact that only links where the build host's system
          // libraries happen to be present.
          'for _need in $(readelf -d {{prefix}}/lib/libcurl.so | sed -n "s/.*NEEDED.*\\[\\(.*\\)\\]/\\1/p"); do',
          '  case "$_need" in libc.so.*|ld-linux*|libm.so.*|libpthread.so.*|libdl.so.*|librt.so.*) continue ;; esac',
          '  [ -e "{{prefix}}/lib/$_need" ] || { echo "curl artifact is missing $_need" >&2; exit 1; }',
          'done',
        ],
        if: 'linux',
      },
    ],
    env: {
      'ARGS': ['--prefix={{prefix}}', '--with-openssl', '--without-libpsl', '--with-ca-fallback', '--with-nghttp2'],
    },
  },
  test: {
    required: true,
    script: [
      'env -u LD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH {{prefix}}/bin/curl --version',
    ],
  },
}
