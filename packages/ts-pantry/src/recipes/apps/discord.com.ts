import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'discord.com',
  name: 'Discord',
  description: 'A voice, video, and text chat platform.',
  homepage: 'https://discord.com',
  programs: ['discord'],
  platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'],
  // Resolve the version from Discord's own official update feed (no Homebrew).
  // The build downloads the matching versioned dmg below.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const res = await fetch('https://discord.com/api/updates/stable?platform=osx')
      const data = await res.json() as any
      return data?.name ? [String(data.name)] : []
    },
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
