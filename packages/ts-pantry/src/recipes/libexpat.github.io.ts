import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'libexpat.github.io',
  name: 'xmlwf',
  description: ':herb: Fast streaming XML parser written in C99 with >90% test coverage; moved from SourceForge to GitHub',
  homepage: 'https://libexpat.github.io/',
  github: 'https://github.com/libexpat/libexpat',
  programs: ['xmlwf'],
  // Keep the original build identity immutable. The first local 2.10 Darwin
  // build inherited macOS 27 from its host; this revision declares the baseline.
  revisions: { '2.10.0': 1 },
  versionSource: {
    type: 'github-releases',
    repo: 'libexpat/libexpat',
    tagPattern: /^R_(\d+)_(\d+)_(\d+)$/,
  },
  distributable: {
    url: 'https://github.com/libexpat/libexpat/releases/download/R_{{version.major}}_{{version.minor}}_{{version.patch}}/expat-{{version}}.tar.xz',
    stripComponents: 1,
  },

  build: {
    env: {
      darwin: { MACOSX_DEPLOYMENT_TARGET: '14.0' },
    },
    script: [
      './configure --prefix={{prefix}}',
      'make --jobs {{hw.concurrency}} install',
      'cd "${{prefix}}/lib"',
      'rm *.la',
    ],
  },
}
