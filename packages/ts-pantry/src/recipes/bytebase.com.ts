import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'bytebase.com',
  name: 'bytebase',
  description: 'Database DevOps and CI/CD tool',
  homepage: 'https://www.bytebase.com',
  github: 'https://github.com/bytebase/bytebase',
  programs: ['bytebase'],
  platforms: ['linux', 'darwin/aarch64'],
  versionSource: {
    type: 'github-releases',
    repo: 'bytebase/bytebase',
  },
  distributable: {
    url: 'git+https://github.com/bytebase/bytebase.git',
    // Without a ref the clone is the default branch, not the release.
    ref: '{{version}}',
  },
  // The frontend is built with node and embedded in the Go binary, so nothing
  // is needed at run time. scripts/build_init.sh refuses to build below its
  // TARGET_GO_VERSION (1.27.3 for 3.25) and TARGET_NODE_VERSION (24.15.0).
  buildDependencies: {
    'go.dev': '>=1.27.3',
    'nodejs.org': '>=24.15',
    'pnpm.io': '>=12',
    'git-scm.org': '^2',
    // beltran/gssapi is cgo; pkgx's recipe builds it against kerberos on linux.
    'linux': {
      'kerberos.org': '1',
    },
  },

  build: {
    script: [
      {
        run: 'sed -i \'s/-ldflags "/-ldflags "-buildmode=pie /\' build_bytebase.sh',
        'working-directory': 'scripts',
        if: 'linux',
      },
      {
        run: 'sed -i "s/^VERSION=\'.*\'$/VERSION=\'{{version}}\'/" build_init.sh',
        'working-directory': 'scripts',
      },
      './scripts/build_bytebase.sh {{prefix}}/bin',
    ],
  },
}
