import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'go.dev',
  name: 'go',
  description: 'The Go programming language',
  homepage: 'https://go.dev',
  github: 'https://github.com/golang/go',
  programs: ['go', 'gofmt'],
  // golang/go publishes NO GitHub releases — the releases API returns an empty
  // list, and its tags API leads with `weekly.2012-*`. A `github-releases`
  // source therefore never resolved a single version, so the catalog froze at
  // whatever was last hand-committed (1.26.1, while upstream was on 1.27.1) and
  // the sweep reported it as one "no versions found" line among 631, not an
  // error. Read the same download index the official installer uses.
  versionSource: {
    type: 'custom',
    async fetch() {
      const resp = await fetch('https://go.dev/dl/?mode=json&include=all', {
        headers: { 'User-Agent': 'pantry-version-fetcher' },
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok)
        return []
      const index = await resp.json() as Array<{ version?: string, stable?: boolean }>
      // Newest first, as the index already returns them. Release candidates
      // (`go1.27rc1`) are excluded: the distributable URL below is the
      // `.src.tar.gz` for a tagged release, and an rc is not one we publish.
      return index
        .filter(entry => entry.stable && typeof entry.version === 'string')
        .map(entry => entry.version!.replace(/^go/, ''))
        .filter(version => /^\d+\.\d+(?:\.\d+)?$/.test(version))
    },
  },
  distributable: {
    url: 'https://go.dev/dl/go{{version.raw}}.src.tar.gz',
    stripComponents: 1,
  },
  dependencies: {
    'openssl.org': '1',
  },
  buildDependencies: {
    'gnu.org/m4': '1',
    'go.dev': '*',
  },

  build: {
    script: [
      './make.bash',
      'rm *.{bash,bat,rc} Make.dist',
      'cd "${{prefix}}"',
      'find . -mindepth 1 -delete',
      'cd "$SRCROOT"',
      'cp -a api bin doc lib misc pkg src test {{prefix}}',
      'if test -f go.env; then',
      '  cp go.env {{prefix}}',
      'fi',
      '',
    ],
    env: {
      'GOCACHE': '$SRCROOT/.gocache',
      'GOROOT_FINAL': '${{prefix}}',
      'GOROOT_BOOTSTRAP': '${{deps.go.dev.prefix}}',
    },
    skip: ['fix-patchelf'],
  },
}
