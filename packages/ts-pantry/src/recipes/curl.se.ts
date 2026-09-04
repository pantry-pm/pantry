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
  },

  build: {
    script: [
      './configure $ARGS',
      'make --jobs {{hw.concurrency}} install',
      {
        run: [
          'cp -L {{deps.openssl.org.prefix}}/lib/libssl.so.3 {{prefix}}/lib/',
          'cp -L {{deps.openssl.org.prefix}}/lib/libcrypto.so.3 {{prefix}}/lib/',
          'cp -L {{deps.zlib.net.prefix}}/lib/libz.so.1 {{prefix}}/lib/',
          'cp -L {{deps.nghttp2.org.prefix}}/lib/libnghttp2.so.14 {{prefix}}/lib/',
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
