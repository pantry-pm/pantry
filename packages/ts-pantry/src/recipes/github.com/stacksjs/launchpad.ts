import type { Recipe } from '../../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'github.com/stacksjs/launchpad',
  name: 'Launchpad',
  description: 'A native keyboard launcher built with Stacks',
  homepage: 'https://github.com/stacksjs/launchpad',
  github: 'https://github.com/stacksjs/launchpad',
  programs: ['launchpad'],
  buildDependencies: { 'jqlang.org': '*' },
  platforms: ['darwin/aarch64'],
  versionSource: { type: 'github-releases', repo: 'stacksjs/launchpad', tagPattern: /^v(.+)$/ },
  build: {
    script: [
      'curl -fSL "https://api.github.com/repos/stacksjs/launchpad/releases/tags/v{{version}}" -o launchpad-release.json',
      'URL=$(jq -er \'.assets[] | select(.name | test("^Launchpad-.*-darwin-arm64\\\\.tar\\\\.gz$")) | .browser_download_url\' launchpad-release.json)',
      'curl -fSL "$URL" -o launchpad.tar.gz',
      'mkdir -p {{prefix}}',
      'tar -xzf launchpad.tar.gz -C {{prefix}}',
      'codesign --verify --deep --strict {{prefix}}/Launchpad.app',
      'xcrun stapler validate {{prefix}}/Launchpad.app',
      'mkdir -p {{prefix}}/bin',
      'ln -sf ../Launchpad.app/Contents/MacOS/Launchpad {{prefix}}/bin/launchpad',
    ],
  },
}
