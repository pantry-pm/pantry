import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'discord.com',
  name: 'Discord',
  description: 'A voice, video, and text chat platform.',
  homepage: 'https://discord.com',
  programs: ['discord'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],
  // Without a versionSource the desktop updater can't resolve a "latest" and
  // skips the package entirely (even with --force), so it silently went stale.
  // Track the Homebrew cask's marketing version (the same one upstream ships).
  versionSource: {
    type: 'homebrew-cask',
    cask: 'discord',
    versionField: 'marketing',
  },

  build: {
    script: [
      'curl -fSL "https://dl.discordapp.net/apps/osx/{{version}}/Discord.dmg" -o /tmp/discord.dmg',
      'hdiutil attach /tmp/discord.dmg -mountpoint /tmp/discord-mount -nobrowse -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/discord-mount/Discord.app" {{prefix}}/Discord.app',
      'hdiutil detach /tmp/discord-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Discord.app/Contents/MacOS/Discord" {{prefix}}/bin/discord',
    ],
  },
}
