import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'fermyon.com/spin',
  name: 'spin',
  programs: [
    'spin',
  ],
  distributable: null,
  build: {
    script: [
      'VERSION={{version}}',
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) ASSET="macos-aarch64" ;;',
      '  darwin+x86-64)  ASSET="macos-amd64" ;;',
      '  linux+aarch64)  ASSET="linux-aarch64" ;;',
      '  linux+x86-64)   ASSET="linux-amd64" ;;',
      '  *) echo "unsupported platform {{hw.platform}}/{{hw.arch}}" >&2; exit 1 ;;',
      'esac',
      '',
      'curl -Lfo spin.tar.gz "https://github.com/fermyon/spin/releases/download/v${VERSION}/spin-v${VERSION}-${ASSET}.tar.gz"',
      'tar xzf spin.tar.gz',
      'install -Dm755 spin {{prefix}}/bin/spin',
    ],
  },
  test: {
    script: [
      'spin --version',
    ],
  },
}
