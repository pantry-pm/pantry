import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'slack.com',
  name: 'Slack',
  description: 'A messaging and collaboration platform for teams.',
  homepage: 'https://slack.com',
  programs: ['slack'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],
  // Resolve the version from Slack's own official download redirect (no
  // Homebrew): the universal installer redirect's final URL embeds the version
  // (.../mac/universal/<version>/Slack-<version>-macOS.dmg). The build downloads
  // that same versioned dmg below.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const res = await fetch('https://slack.com/ssb/download-osx-universal', { method: 'HEAD', redirect: 'follow' })
      const m = res.url.match(/\/universal\/([\d.]+)\//)
      return m ? [m[1]] : []
    },
  },

  build: {
    script: [
      'curl -fSL "https://downloads.slack-edge.com/desktop-releases/mac/universal/{{version}}/Slack-{{version}}-macOS.dmg" -o /tmp/slack.dmg',
      'hdiutil attach /tmp/slack.dmg -mountpoint /tmp/slack-mount -nobrowse -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/slack-mount/Slack.app" {{prefix}}/Slack.app',
      'hdiutil detach /tmp/slack-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Slack.app/Contents/MacOS/Slack" {{prefix}}/bin/slack',
    ],
  },
}
