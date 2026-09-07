import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'haskell.org/cabal',
  name: 'cabal',
  description: 'Official upstream development repository for Cabal and cabal-install',
  homepage: 'https://www.haskell.org/cabal/',
  github: 'https://github.com/haskell/cabal',
  programs: ['cabal'],
  dependencies: {
    'gnu.org/gmp': '6',
    'zlib.net': '1',
  },
  versionSource: {
    type: 'github-releases',
    repo: 'haskell/cabal',
    // tags look like `cabal-install-v3.12.1.0` or `Cabal-v3.10.3.0`
    tagPattern: /^[Cc]abal(?:-install)?-v(.+)$/,
  },
  distributable: null,

  build: {
    script: [
      '# Upstream renamed its assets at 3.18: aarch64-darwin became',
      '# aarch64-apple-darwin, and the linux distro suffix (deb10) became',
      '# `unknown`. A single hardcoded spelling therefore 404s for half the',
      '# catalog whichever one it picks, so try each in turn.',
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) SUFFIXES="aarch64-apple-darwin aarch64-darwin" ;;',
      '  darwin+x86-64)  SUFFIXES="x86_64-apple-darwin x86_64-darwin" ;;',
      '  linux+x86-64)   SUFFIXES="x86_64-linux-unknown x86_64-linux-deb10" ;;',
      '  linux+aarch64)  SUFFIXES="aarch64-linux-unknown aarch64-linux-deb10" ;;',
      '  *) echo "unsupported platform {{hw.platform}}/{{hw.arch}}" >&2; exit 1 ;;',
      'esac',
      'ASSET=""',
      'for suffix in $SUFFIXES; do',
      '  candidate="cabal-install-{{version}}-${suffix}.tar.xz"',
      '  if curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 600 -o "$candidate" "https://downloads.haskell.org/~cabal/cabal-install-{{version}}/$candidate"; then',
      '    ASSET="$candidate"; break',
      '  fi',
      'done',
      'if [ -z "$ASSET" ]; then echo "no cabal asset for {{hw.platform}}/{{hw.arch}} at {{version}} (tried: $SUFFIXES)" >&2; exit 1; fi',
      'mkdir extract {{prefix}}/bin',
      'tar -xJf "$ASSET" -C extract',
      'install -m755 extract/cabal {{prefix}}/bin/cabal',
    ],
  },

  test: {
    script: [
      'test "$(cabal --numeric-version)" = "{{version}}"',
    ],
  },
}
