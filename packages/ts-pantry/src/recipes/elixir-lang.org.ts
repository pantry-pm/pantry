import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'elixir-lang.org',
  name: 'elixir-lang',
  description: 'Elixir is a dynamic, functional language for building scalable and maintainable applications',
  homepage: 'https://elixir-lang.org/',
  github: 'https://github.com/elixir-lang/elixir',
  programs: ['elixir', 'elixirc', 'iex', 'mix'],
  versionSource: {
    type: 'github-releases',
    repo: 'elixir-lang/elixir',
    // Numeric releases only. Upstream also keeps rolling `v1.20-latest` /
    // `v1.19-latest` releases that are re-pointed at every patch: they are not
    // versions, and `(.+)` took them into the catalog as `1.20-latest`.
    tagPattern: /^v(\d+\.\d+\.\d+)$/,
  },
  distributable: {
    url: 'https://github.com/elixir-lang/elixir/archive/refs/tags/v{{version}}.tar.gz',
    stripComponents: 1,
  },

  // The Makefile drives erlc/erl, and the installed elixir/iex/mix launchers
  // exec erl at runtime. Without this the build has no Erlang at all
  // ("make: erlc: No such file or directory").
  dependencies: {
    'erlang.org': '>=25',
  },

  build: {
    script: [
      // The catalog never prunes, so the rolling `*-latest` entries already in
      // it keep being selected. They name a moving tag, not a release: report
      // them as having no source rather than publish an unreproducible build.
      'case "{{version}}" in *-latest) echo "elixir {{version}} is a rolling upstream tag, not a release" >&2; exit 42 ;; esac',
      'make --jobs {{hw.concurrency}}',
      'make install PREFIX={{prefix}}',
    ],
  },
}
