import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'mise.jdx.dev',
  name: 'mise',
  description: 'dev tools, env vars, task runner',
  homepage: 'https://mise.jdx.dev',
  github: 'https://github.com/jdx/mise',
  programs: ['rtx', 'mise'],
  versionSource: {
    type: 'github-releases',
    repo: 'jdx/mise',
    tagPattern: /^v(.+)$/,
  },
  distributable: {
    url: 'https://github.com/jdx/mise/archive/refs/tags/{{version.tag}}.tar.gz',
    stripComponents: 1,
  },
  dependencies: {
    'openssl.org': '^1.1',
    'libgit2.org': '^1',
  },
  buildDependencies: {
    // The floor is Cargo.toml's `rust-version` (1.95 since v2026.8.11), which
    // cargo enforces for mise and its locked crates. A lower bound here lets
    // resolution hand the build the newest published compiler even when that
    // one is too old, and the failure only shows up minutes into the build.
    'rust-lang.org': '>=1.95',
    'rust-lang.org/cargo': '*',
    'cmake.org': '3',
  },
  dependencyOverrides: [
    // rust-version was 1.93 for v2026.8.6 to v2026.8.10 and 1.91 or lower before.
    { if: '<2026.8.11', buildDependencies: { 'rust-lang.org': '>=1.93' } },
  ],

  build: {
    script: [
      'cargo install --locked --path . --root {{prefix}}',
      'cd {{prefix}}/bin',
      'if test -f rtx; then',
      '  ln -s rtx mise',
      'elif test -f mise; then',
      '  ln -s mise rtx',
      'fi',
      '',
    ],
  },
}
