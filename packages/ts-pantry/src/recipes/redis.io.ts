import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'redis.io',
  name: 'redis',
  description: 'Redis is an in-memory database that persists on disk. The data model is key-value, but many different kind of values are supported: Strings, Lists, Sets, Sorted Sets, Hashes, Streams, HyperLogLogs, Bitmaps.',
  homepage: 'https://redis.io',
  github: 'https://github.com/redis/redis',
  programs: ['redis-server', 'redis-cli', 'redis-benchmark'],
  versionSource: {
    type: 'github-releases',
    repo: 'redis/redis',
  },
  distributable: {
    url: 'https://download.redis.io/releases/redis-{{version}}.tar.gz',
    stripComponents: 1,
  },
  dependencies: {
    // Redis 8 links libssl/libcrypto for BUILD_TLS=yes. Pin OpenSSL 3 so the
    // binary needs libssl.so.3 — present on modern distros (Ubuntu 22.04+/24.04)
    // — instead of the long-gone libssl.so.1.1 that broke `redis-server` at load.
    'openssl.org': '^3',
  },

  build: {
    script: [
      'make install',
    ],
    env: {
      'PREFIX': '${{prefix}}',
      'BUILD_TLS': 'yes',
    },
  },
}
