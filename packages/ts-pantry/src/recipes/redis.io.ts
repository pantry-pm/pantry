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
      // `install` depends on `all`, and `all` depends on `module_tests`, which
      // recurses into tests/modules — test fixtures we never ship. That sub-make
      // links with `$(LD)`, and on Darwin nothing reassigns LD (redis only sets
      // `LD = gcc` inside its `ifeq ($(uname_S),Linux)` branch), so it invokes
      // the RAW linker. Our LDFLAGS carry `-Wl,-rpath,...`, which is a compiler-
      // driver option, and raw ld rejects it:
      //   ld: unknown option: -Wl,-rpath,/tmp/buildkit-deps-redis.io/openssl.org/...
      // The server, sentinel, cli and benchmark had all linked fine by then; the
      // whole darwin build failed on test fixtures. Drop them from `all` — we
      // never install them, so not building them is strictly correct, and the
      // edit is scoped to that one target so `module_tests:` itself and the
      // `test:` target keep working for anyone running them.
      "sed -i.bak 's/^\\(all:.*\\) module_tests$/\\1/' src/Makefile",
      // PREFIX goes on the make COMMAND LINE, not in the environment. Redis
      // 8.10.1's top-level Makefile ignores an environment PREFIX and installs
      // to /usr/local/bin regardless. Locally that fails loudly with
      // "mkdir: /usr/local/bin: Permission denied"; on a CI runner /usr/local
      // IS writable, so `make install` exits 0 having put the binaries
      // somewhere we never look, and the build fails one step later with
      // "Build produced no files in /tmp/buildkit-install-redis.io" — with
      // nothing in the log pointing at the cause. A command-line variable
      // beats both the environment and any makefile assignment, so this cannot
      // be overridden again.
      'make install PREFIX={{prefix}}',
    ],
    env: {
      // BUILD_TLS is read from the environment correctly (it lands in redis's
      // .make-settings), so it stays here.
      'BUILD_TLS': 'yes',
    },
  },
}
