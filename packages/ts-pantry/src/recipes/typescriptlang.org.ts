import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'typescriptlang.org',
  name: 'tsc',
  description: 'TypeScript is a superset of JavaScript that compiles to clean JavaScript output.',
  homepage: 'https://www.typescriptlang.org/',
  github: 'https://github.com/Microsoft/TypeScript',
  programs: ['tsc'],
  // TypeScript 7 stable releases are published to npm before GitHub's release
  // feed is updated. Resolve the canonical npm dist-tag so Pantry can install
  // the same current version that JavaScript package managers resolve.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const response = await fetch('https://registry.npmjs.org/typescript/latest')
      if (!response.ok)
        return []
      const metadata = await response.json() as { version?: string }
      return metadata.version ? [metadata.version] : []
    },
  },
  distributable: {
    url: 'https://registry.npmjs.org/typescript/-/typescript-{{version}}.tgz',
    stripComponents: 1,
  },
  dependencies: {
    'nodejs.org': '^20',
  },
  buildDependencies: {
    'npmjs.com': '*',
  },

  build: {
    script: [
      'npm install $ARGS',
    ],
    env: {
      'ARGS': ['-ddd', '--global', '--build-from-source', '--prefix={{prefix}}', '--install-links', '--unsafe-perm'],
    },
  },
}
