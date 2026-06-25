import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'ghostty.org',
  name: 'Ghostty',
  description: 'A fast, feature-rich, and cross-platform terminal emulator.',
  homepage: 'https://ghostty.org',
  github: 'https://github.com/ghostty-org/ghostty',
  programs: ['ghostty'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  // Ghostty's GitHub releases are marked pre-release, so `releases/latest` 404s
  // (the github-releases source resolves to null). Read the Git TAGS instead and
  // take the highest stable v<semver> — Ghostty's own repo, no Homebrew. The
  // .dmg download URL below is versioned by {{version}}.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const headers: Record<string, string> = { 'User-Agent': 'pantry-desktop' }
      if (process.env.GITHUB_TOKEN)
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
      const res = await fetch('https://api.github.com/repos/ghostty-org/ghostty/tags?per_page=30', { headers })
      const tags = await res.json() as Array<{ name: string }>
      const vs = tags
        .map(t => t.name.match(/^v(\d+\.\d+\.\d+)$/)?.[1])
        .filter((v): v is string => !!v)
      vs.sort((a, b) => {
        const pa = a.split('.').map(Number)
        const pb = b.split('.').map(Number)
        for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pb[i] - pa[i] }
        return 0
      })
      return vs.length ? [vs[0]] : []
    },
  },

  build: {
    script: [
      'curl -fSL "https://release.files.ghostty.org/{{version}}/Ghostty.dmg" -o /tmp/ghostty.dmg',
      'hdiutil attach /tmp/ghostty.dmg -mountpoint /tmp/ghostty-mount -nobrowse -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/ghostty-mount/Ghostty.app" {{prefix}}/Ghostty.app',
      'hdiutil detach /tmp/ghostty-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Ghostty.app/Contents/MacOS/ghostty" {{prefix}}/bin/ghostty',
    ],
  },
}
