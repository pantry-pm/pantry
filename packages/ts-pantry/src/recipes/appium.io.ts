import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'appium.io',
  name: 'appium',
  description: 'Cross-platform automation framework for all kinds of apps, built on top of the W3C WebDriver protocol',
  homepage: 'https://appium.io/',
  github: 'https://github.com/appium/appium',
  programs: ['appium'],
  versionSource: {
    type: 'github-releases',
    repo: 'appium/appium',
    tagPattern: /^appium@(\d+(?:\.\d+){0,3})$/,
  },
  distributable: {
    url: 'https://registry.npmjs.org/appium/-/appium-{{version}}.tgz',
    stripComponents: 1,
  },
  dependencies: {
    'npmjs.com': '*',
    // appium 3 declares node ^20.19 || ^22.12 || >=24 and appium 4 narrows it
    // to ^22.22.2 || ^24.15 || >=26; this range satisfies both.
    'nodejs.org': '^22.22.2 || ^24.15 || >=26',
    'openjdk.org': '*',
  },
  buildDependencies: {},

  build: {
    script: [
      // The package bin is index.js (later 3.x releases dropped lib/appium.js); npm
      // links it executable, so nothing needs a chmod.
      'EXTRA_PACKAGES="@appium/logger"',
      'npm install . $EXTRA_PACKAGES --global --prefix={{prefix}} --install-links',
    ],
  },
}
