import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'memcached.org',
  name: 'memcached',
  programs: ['memcached'],
  versionSource: {
    type: 'github-tags',
    repo: 'memcached/memcached',
  },
  distributable: {
    url: 'https://memcached.org/files/memcached-{{version}}.tar.gz',
    stripComponents: 1,
  },
  dependencies: {
    'libevent.org': '*',
  },
  buildDependencies: {
    'freedesktop.org/pkg-config': '*',
  },

  build: {
    script: [
      './configure $ARGS',
      'make --jobs {{hw.concurrency}}',
      'make install',
    ],
    env: {
      'ARGS': ['--prefix={{prefix}}', '--with-libevent={{deps.libevent.org.prefix}}'],
    },
  },
}
