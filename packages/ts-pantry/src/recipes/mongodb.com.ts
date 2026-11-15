import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'mongodb.com',
  name: 'mongodb',
  description: 'The MongoDB Database',
  homepage: 'https://www.mongodb.com/',
  github: 'https://github.com/mongodb/mongo',
  programs: ['install_compass', 'mongod', 'mongos'],
  versionSource: {
    type: 'github-tags',
    repo: 'mongodb/mongo',
    tagPattern: /^r(\d+(?:\.\d+){0,3})$/,
  },
  distributable: null,
  dependencies: {
    'curl.se': '8',
    'openssl.org': '1.1',
  },
  // 9.0 dropped the Ubuntu 20.04 archive this recipe used for Linux (fastdl
  // answers 403 for it). The Ubuntu 22.04 archive it downloads instead links
  // OpenSSL 3 (libssl.so.3), not 1.1. Replaces the key above rather than adding
  // a `linux` group, which would be merged with 1.1 into an unsatisfiable range.
  dependencyOverrides: [{
    if: '>=9',
    dependencies: {
      'openssl.org': '^3',
    },
  }],

  build: {
    script: [
      {
        run: 'DIST="${DIST/-ubuntu2004-/-ubuntu2204-}"',
        if: '>=9',
      },
      // Check the status instead of piping into tar: fastdl answers a missing
      // archive with a 403 XML body, which surfaced as "not in gzip format".
      'STATUS="$(curl -sSL -o mongodb.tgz -w "%{http_code}" "$DIST")"',
      'case "$STATUS" in',
      '  200) ;;',
      '  403|404) echo "no MongoDB {{version}} archive at $DIST (HTTP $STATUS)" >&2; exit 42 ;;',
      '  *) echo "downloading $DIST failed (HTTP $STATUS)" >&2; exit 1 ;;',
      'esac',
      'tar xzf mongodb.tgz --strip-components=1',
      'mkdir -p {{prefix}}/bin',
      'cp -a bin/* {{prefix}}/bin',
    ],
    env: {
      'darwin/aarch64': {
        DIST: 'https://fastdl.mongodb.org/osx/mongodb-macos-arm64-{{version}}.tgz',
      },
      'darwin/x86-64': {
        DIST: 'https://fastdl.mongodb.org/osx/mongodb-macos-x86_64-{{version}}.tgz',
      },
      'linux/aarch64': {
        DIST: 'https://fastdl.mongodb.org/linux/mongodb-linux-aarch64-ubuntu2004-{{version}}.tgz',
      },
      'linux/x86-64': {
        DIST: 'https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-ubuntu2004-{{version}}.tgz',
      },
    },
  },
}
