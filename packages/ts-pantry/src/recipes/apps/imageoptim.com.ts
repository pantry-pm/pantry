import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'imageoptim.com',
  name: 'ImageOptim',
  description: 'An image optimizer for macOS.',
  homepage: 'https://imageoptim.com',
  programs: ['imageoptim'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  // Resolve the version from ImageOptim's own Sparkle appcast (no Homebrew). The
  // build uses the rolling .tbz2, which currently ships the same version; the
  // appcast is the authoritative version signal (GitHub releases are stale).
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const xml = await (await fetch('https://imageoptim.com/appcast.xml')).text()
      const m = xml.match(/sparkle:shortVersionString="([^"]+)"/) || xml.match(/sparkle:version="([^"]+)"/)
      return m ? [m[1]] : []
    },
  },

  build: {
    script: [
      'curl -fSL -L "https://imageoptim.com/ImageOptim.tbz2" -o /tmp/imageoptim.tbz2',
      'cd /tmp && tar xjf imageoptim.tbz2',
      'mkdir -p {{prefix}}',
      'mv "/tmp/ImageOptim.app" {{prefix}}/ImageOptim.app',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../ImageOptim.app/Contents/MacOS/ImageOptim" {{prefix}}/bin/imageoptim',
    ],
  },
}
