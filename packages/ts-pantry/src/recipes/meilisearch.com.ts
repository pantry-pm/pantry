import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'meilisearch.com',
  name: 'meilisearch',
  description: 'A lightning-fast search engine API bringing AI-powered hybrid search to your sites and applications.',
  homepage: 'https://www.meilisearch.com/',
  github: 'https://github.com/meilisearch/meilisearch',
  programs: ['meilisearch'],
  versionSource: {
    type: 'github-releases',
    repo: 'meilisearch/meilisearch',
    tagPattern: /^v(.+)$/,
  },
  distributable: null,

  // A single upstream binary per platform — no compile, nothing we customize.
  //
  // The script used to curl a bare `$DIST` that nothing ever set: the buildkit
  // exports only `prefix`, `PREFIX` and `SRCROOT`, and this recipe declared no
  // `build.env`, so the variable expanded to empty and the download could never
  // work. The only path that actually published meilisearch was the hand-coded
  // entry in scripts/sync-packages.ts, and that runs solely from
  // sync-binaries.yml, which has no cron — so the registry sat five minor
  // versions behind (1.48.3 while upstream was on 1.53.1) with nothing
  // reporting a failure. Declaring DIST per platform, the way every other
  // download recipe here does, makes the recipe self-sufficient and lets the
  // ordinary publish path build it for any target from any box.
  build: {
    script: [
      'mkdir -p {{prefix}}/bin',
      'curl -fSL "$DIST" -o {{prefix}}/bin/meilisearch',
      'chmod +x {{prefix}}/bin/meilisearch',
      // Upstream serves an HTML error page with a 200 for some missing assets;
      // a real build is tens of MB, so a tiny file means the URL was wrong.
      'test "$(wc -c < {{prefix}}/bin/meilisearch)" -gt 1000000',
    ],
    env: {
      'darwin/aarch64': {
        DIST: 'https://github.com/meilisearch/meilisearch/releases/download/v{{version}}/meilisearch-macos-apple-silicon',
      },
      'darwin/x86-64': {
        DIST: 'https://github.com/meilisearch/meilisearch/releases/download/v{{version}}/meilisearch-macos-amd64',
      },
      'linux/aarch64': {
        DIST: 'https://github.com/meilisearch/meilisearch/releases/download/v{{version}}/meilisearch-linux-aarch64',
      },
      'linux/x86-64': {
        DIST: 'https://github.com/meilisearch/meilisearch/releases/download/v{{version}}/meilisearch-linux-amd64',
      },
    },
  },
  test: {
    required: true,
    script: ['{{prefix}}/bin/meilisearch --version'],
  },
}
