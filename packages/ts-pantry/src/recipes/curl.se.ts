import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'curl.se',
  name: 'cURL',
  revisions: { '8.23.0': 3 },
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
    'gnu.org/libidn2': '^2.3.8.2',
    'github.com/google/brotli': '^1.2.0.1',
    'facebook.com/zstd': '^1.5.7.2',
  },

  build: {
    script: [
      './configure $ARGS',
      'make --jobs {{hw.concurrency}} install',
    ],
    env: {
      'ARGS': ['--prefix={{prefix}}', '--with-openssl', '--without-libpsl', '--with-ca-fallback', '--with-nghttp2'],
      'darwin': { MACOSX_DEPLOYMENT_TARGET: '14.0' },
    },
  },
  test: {
    required: true,
    script: [
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH {{prefix}}/bin/curl --version',
      `cat > curl-consumer.c <<'PANTRY_C'
#include <curl/curl.h>
#include <string.h>
static int supports(const curl_version_info_data *info, const char *name, int legacy_bit) {
#if LIBCURL_VERSION_NUM >= 0x075700
  (void)legacy_bit;
  if (info->age < CURLVERSION_ELEVENTH || !info->feature_names) return 0;
  for (const char *const *feature = info->feature_names; *feature; feature++) {
    if (strcmp(*feature, name) == 0) return 1;
  }
  return 0;
#else
  (void)name;
  return (info->features & legacy_bit) != 0;
#endif
}
int main(void) {
  if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) return 1;
  const curl_version_info_data *info = curl_version_info(CURLVERSION_NOW);
  if (!info || info->version_num != LIBCURL_VERSION_NUM || !supports(info, "SSL", CURL_VERSION_SSL) || !supports(info, "IDN", CURL_VERSION_IDN) || !supports(info, "HTTP2", CURL_VERSION_HTTP2) || !supports(info, "brotli", CURL_VERSION_BROTLI) || !supports(info, "zstd", CURL_VERSION_ZSTD)) {
    curl_global_cleanup();
    return 2;
  }
  CURL *client = curl_easy_init();
  if (!client) { curl_global_cleanup(); return 3; }
  curl_easy_cleanup(client);
  curl_global_cleanup();
  return 0;
}
PANTRY_C`,
      'cc -I"{{prefix}}/include" curl-consumer.c -L"{{prefix}}/lib" -Wl,-rpath,"{{prefix}}/lib" -lcurl -o curl-consumer',
      'env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH ./curl-consumer',
    ],
  },
}
