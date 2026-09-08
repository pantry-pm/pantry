import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'getfoundry.sh',
  name: 'getfoundry.sh',
  description: 'Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.',
  homepage: 'https://getfoundry.sh',
  github: 'https://github.com/foundry-rs/foundry',
  programs: ['forge', 'anvil', 'cast', 'chisel'],
  versionSource: {
    type: 'github-releases',
    repo: 'foundry-rs/foundry',
  },

  build: {
    script: [
      // TARGET, not host — see dart.dev. `uname` here published whatever the
      // runner happened to be under whichever platform key was asked for.
      'OS={{hw.platform}}',
      'case {{hw.arch}} in',
      '  aarch64) ARCH="arm64" ;;',
      '  x86-64)  ARCH="amd64" ;;',
      '  *) echo "unsupported arch {{hw.arch}}" >&2; exit 42 ;;',
      'esac',
      'mkdir -p {{prefix}}/bin',
      'curl -fSL "https://github.com/foundry-rs/foundry/releases/download/v{{version}}/foundry_v{{version}}_${OS}_${ARCH}.tar.gz" | tar xz -C {{prefix}}/bin',
      'chmod +x {{prefix}}/bin/forge {{prefix}}/bin/cast {{prefix}}/bin/anvil {{prefix}}/bin/chisel',
    ],
  },
}
