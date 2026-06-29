import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'raycast.com',
  name: 'Raycast',
  description: 'A blazingly fast launcher and productivity tool for macOS.',
  homepage: 'https://raycast.com',
  programs: ['raycast'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],
  // Resolve the version from Raycast's own official releases feed (no Homebrew).
  // The build downloads the matching versioned dmg below.
  versionSource: {
    type: 'custom',
    fetch: async (): Promise<string[]> => {
      const res = await fetch('https://releases.raycast.com/releases/latest?build=universal')
      const data = await res.json() as any
      return data?.version ? [String(data.version)] : []
    },
  },

  build: {
    script: [
      // Raycast's download endpoint keys on `?build=` (NOT `?arch=`): the
      // variants are `arm64`, `x86` and `universal`. An unknown param like
      // `?arch=arm64` silently falls back to the x86 dmg — which is how the
      // darwin-arm64 artifact ended up holding an Intel binary. Map our arch to
      // the matching single-arch build so each platform's artifact is native.
      'if test {{hw.arch}} = "aarch64"; then BUILD="arm64"; else BUILD="x86"; fi',
      'curl -fSL "https://releases.raycast.com/releases/{{version}}/download?build=${BUILD}" -o /tmp/raycast.dmg',
      'hdiutil attach /tmp/raycast.dmg -mountpoint /tmp/raycast-mount -nobrowse -quiet',
      'mkdir -p {{prefix}}',
      'cp -R "/tmp/raycast-mount/Raycast.app" {{prefix}}/Raycast.app',
      'hdiutil detach /tmp/raycast-mount -quiet || true',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Raycast.app/Contents/MacOS/Raycast" {{prefix}}/bin/raycast',
    ],
  },
}
