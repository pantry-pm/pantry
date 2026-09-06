import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  propsDir: 'props/openssl.org',
  domain: 'openssl.org',
  name: 'OpenSSL',
  description: 'TLS/SSL and crypto library',
  homepage: 'https://www.openssl.org',
  github: 'https://github.com/openssl/openssl',
  programs: ['openssl', 'c_rehash'],
  // Discover from the same project the distributable below actually downloads.
  // This pointed at the quictls FORK while `distributable.url` fetched from
  // www.openssl.org, so the two could never agree: quictls tags
  // `openssl-3.3.0-quic1`, and
  // https://www.openssl.org/source/openssl-3.3.0-quic1.tar.gz is a 404. The
  // source resolved nothing at all, which is the only reason it never produced
  // a broken build — the catalog's 3.x entries came from somewhere else.
  // Upstream's own `openssl-3.6.4` tags resolve 200 against that same URL.
  //
  // The description/homepage/github said quictls too. Nothing here builds
  // quictls: the tarball is upstream's, and the version-gated patches are
  // pkgx's diffs against upstream. Saying otherwise invites someone to
  // conclude we ship a fork with different QUIC behaviour.
  versionSource: {
    type: 'github-releases',
    repo: 'openssl/openssl',
    tagPattern: /^openssl-(\d+(?:\.\d+){0,3})$/,
  },
  distributable: {
    url: 'https://www.openssl.org/source/openssl-{{version.raw}}.tar.gz',
    stripComponents: 1,
  },

  build: {
    script: [
      // Version-gated patches (pkgx ships separate diffs across the 3.4.0 line).
      { run: 'patch -p1 <props/x509_def.c.diff', if: '<3.4.0' },
      { run: 'patch -p1 <props/x509_def.c.post3.4.0.diff', if: '>=3.4.0' },
      // $ARCH is the OpenSSL Configure target, set per-arch via build.env below.
      './Configure --prefix={{prefix}} $ARCH no-tests $ARGS --openssldir={{prefix}}/ssl',
      'make --jobs {{hw.concurrency}}',
      'make install_sw # `_sw` avoids installing docs',
      // Install the default openssl.cnf shipped in the source tree.
      { run: 'cp $SRCROOT/apps/openssl.cnf .', 'working-directory': '{{prefix}}/ssl' },
    ],
    env: {
      'darwin/aarch64': { ARCH: 'darwin64-arm64-cc' },
      'darwin/x86-64': { ARCH: 'darwin64-x86_64-cc' },
      'linux/aarch64': { ARCH: 'linux-aarch64' },
      'linux/x86-64': { ARCH: 'linux-x86_64' },
      // supposedly enables important optimizations
      'darwin': { ARGS: 'enable-ec_nistp_64_gcc_128' },
    },
  },
}
