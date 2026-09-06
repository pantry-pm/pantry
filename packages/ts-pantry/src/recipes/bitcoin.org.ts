import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'bitcoin.org',
  name: 'bitcoin',
  description: 'Decentralized, peer to peer payment network',
  homepage: 'https://bitcoincore.org/',
  github: 'https://github.com/bitcoin/bitcoin',
  programs: ['bitcoin-cli', 'bitcoin-tx', 'bitcoin-util', 'bitcoin-wallet', 'bitcoind'],
  versionSource: {
    type: 'github-releases',
    repo: 'bitcoin/bitcoin',
  },
  // Prebuilt download: Bitcoin Core publishes official signed per-platform
  // binary tarballs for every Pantry target platform. The source recipe pulls a
  // large Boost/libevent/sqlite/BDB toolchain and was skipped on Darwin; the
  // upstream release tarballs are the canonical distributables users expect.
  distributable: null,

  build: {
    script: [
      'VERSION={{version}}',
      // Upstream's directory and filename both carry the FULL version:
      // bitcoin-core-31.0/bitcoin-31.0-x86_64-linux-gnu.tar.gz. Stripping the
      // trailing `.0` produced bitcoin-core-31/bitcoin-31-... which 404s, and
      // always has — bitcoin-core-22 is a 404 the same way bitcoin-core-22.0 is
      // a 200. Every `.0` release this recipe ever saw failed on it; it only
      // surfaced when 31.0 reached the catalog.
      'DIST_VERSION="$VERSION"',
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) TARGET="arm64-apple-darwin" ;;',
      '  darwin+x86-64)  TARGET="x86_64-apple-darwin" ;;',
      '  linux+aarch64)  TARGET="aarch64-linux-gnu" ;;',
      '  linux+x86-64)   TARGET="x86_64-linux-gnu" ;;',
      '  *) echo "unsupported platform {{hw.platform}}/{{hw.arch}}" >&2; exit 1 ;;',
      'esac',
      '',
      'URL="https://bitcoincore.org/bin/bitcoin-core-${DIST_VERSION}/bitcoin-${DIST_VERSION}-${TARGET}.tar.gz"',
      'curl -Lfo bitcoin.tar.gz "$URL"',
      'mkdir -p {{prefix}}',
      'tar xzf bitcoin.tar.gz --strip-components=1 -C {{prefix}}',
    ],
  },
  test: {
    script: [
      'bitcoin-cli --version',
    ],
  },
}
