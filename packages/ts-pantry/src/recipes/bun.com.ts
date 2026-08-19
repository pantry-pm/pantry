import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  // `bun.com`, not `bun.sh`, and the difference is what gets built where.
  //
  // The catalog calls this package `bun.com` - bun renamed its own domain - so
  // that is what `pantry install bun` resolves to, and the registry is asked
  // for binaries under that name. This recipe still said `bun.sh`, so every
  // artifact was published under a domain nothing looks up: the binary registry
  // answered "no versions" and the install fell through to npm's `bun` package,
  // a postinstall shim with no runtime in it.
  domain: 'bun.com',
  name: 'bun',
  description: 'Incredibly fast JavaScript runtime, bundler, test runner, and package manager – all in one',
  homepage: 'https://bun.sh',
  github: 'https://github.com/oven-sh/bun',
  programs: ['bun', 'bunx'],
  versionSource: {
    type: 'github-releases',
    repo: 'oven-sh/bun',
    tagPattern: /^bun-(.+)$/,
  },
  buildDependencies: {
    'curl.se': '*',
    'info-zip.org/unzip': '*',
  },

  build: {
    script: [
      'curl -Lfo bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v{{version}}/bun-$PLATFORM.zip"',
      'unzip -j bun.zip',
      'rm bun.zip',
      'ln -s bun bunx',
    ],
    skip: ['fix-patchelf'],
  },
}
