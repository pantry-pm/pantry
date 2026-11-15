import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'casdoor.org',
  name: 'casdoor',
  programs: ['casdoor'],
  versionSource: {
    type: 'github-releases',
    repo: 'casdoor/casdoor',
  },
  distributable: {
    url: 'https://github.com/casdoor/casdoor/archive/refs/tags/{{version.tag}}.tar.gz',
    stripComponents: 1,
  },
  buildDependencies: {
    // go.mod asks for go >= 1.26 and upstream's Dockerfile builds the vite
    // frontend on node 20; the old exact node 18.19.0 pin is not a published binary.
    'go.dev': '^1.26',
    'nodejs.org': '^20',
    'classic.yarnpkg.com': '^1',
  },

  build: {
    script: [
      {
        'working-directory': 'web',
        run: [
          'yarn install --network-timeout 1000000',
          'NODE_OPTIONS="--max-old-space-size=4096" yarn run build',
        ],
      },
      {
        'working-directory': '${BUILD_DIR}',
        run: [
          'mkdir -p ${FRONTEND_PATH}',
          'cp -R . ${FRONTEND_PATH}',
        ],
      },
      { run: 'go build ${GO_ARGS} -ldflags="${GO_LDFLAGS}" ./' },
      {
        'working-directory': 'conf',
        run: [
          'mkdir -p ${SAMPLE_CONFIG_PATH}',
          'cp ${PWD}/app.conf ${SAMPLE_CONFIG_PATH}',
        ],
      },
    ],
    env: {
      'BUILD_DIR': 'web/build',
      'FRONTEND_PATH': '{{prefix}}/${BUILD_DIR}',
      'SAMPLE_CONFIG_PATH': '{{prefix}}/etc/casdoor',
      'CGO_ENABLED': '0',
      'GO_ARGS': ['-o {{prefix}}/bin/'],
      'GO_LDFLAGS': ['-s', '-w'],
      'linux': {
        GO_LDFLAGS: ['-s', '-w', '-buildmode=pie'],
      },
    },
  },
}
