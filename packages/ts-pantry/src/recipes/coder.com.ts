import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'coder.com',
  name: 'coder',
  description: 'Tool for provisioning self-hosted development environments with Terraform',
  homepage: 'https://coder.com',
  github: 'https://github.com/coder/coder',
  programs: ['coder'],
  versionSource: {
    type: 'github-releases',
    repo: 'coder/coder',
  },
  distributable: {
    url: 'git+https://github.com/coder/coder.git',
    // Without a ref the clone is the default branch, not the release.
    ref: 'v{{version}}',
  },
  buildDependencies: {
    // go.mod asks for go 1.26.10 and uses a `tool` block, which go before 1.24
    // cannot even parse.
    'go.dev': '>=1.26.10',
  },

  build: {
    script: [
      'go build $ARGS -ldflags="$LD_FLAGS" ./cmd/coder',
    ],
    env: {
      'ARGS': ['-trimpath', '-o={{prefix}}/bin/coder', '-tags slim'],
      'LD_FLAGS': ['-s', '-w', '-X github.com/coder/coder/v2/buildinfo.tag={{version}}', '-X github.com/coder/coder/v2/buildinfo.agpl=true'],
    },
  },
}
