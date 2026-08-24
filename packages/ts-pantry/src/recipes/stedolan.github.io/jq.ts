import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'stedolan.github.io/jq',
  name: 'jq',
  github: 'https://github.com/jqlang/jq',
  programs: [
    'jq',
  ],
  distributable: null,
  build: {
    script: [
      'TAG={{version.tag}}',
      'MAJOR={{version.major}}',
      'MINOR={{version.minor}}',
      'if [ "$MAJOR" -eq 1 ] && [ "$MINOR" -le 6 ]; then',
      '  case {{hw.platform}}+{{hw.arch}} in',
      '    darwin+x86-64) ASSET="jq-osx-amd64" ;;',
      '    linux+x86-64)  ASSET="jq-linux64"   ;;',
      '    *) echo "jq ${TAG} has no prebuilt binary for {{hw.platform}}/{{hw.arch}} (arm64 added in 1.7)" && exit 1 ;;',
      '  esac',
      'else',
      '  case {{hw.platform}}+{{hw.arch}} in',
      '    darwin+aarch64) ASSET="jq-macos-arm64" ;;',
      '    darwin+x86-64)  ASSET="jq-macos-amd64" ;;',
      '    linux+aarch64)  ASSET="jq-linux-arm64" ;;',
      '    linux+x86-64)   ASSET="jq-linux-amd64" ;;',
      '  esac',
      'fi',
      '',
      'curl -Lfo jq "https://github.com/jqlang/jq/releases/download/${TAG}/${ASSET}"',
      'install -Dm755 jq {{prefix}}/bin/jq',
    ],
  },
  test: {
    script: [
      "test \"$(echo '{\"a\":42}' | jq .a)\" = \"42\"",
    ],
  },
}
