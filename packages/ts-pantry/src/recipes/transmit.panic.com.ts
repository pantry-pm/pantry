import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'transmit.panic.com',
  name: 'Transmit',
  description: 'A file transfer client for macOS.',
  homepage: 'https://panic.com/transmit',
  programs: ['transmit'],
  platforms: ['darwin/aarch64', 'darwin/x86-64'],

  build: {
    script: [
      'set -e',
      'UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"',
      'BREW_URL=$(brew info --cask --json=v2 transmit 2>/dev/null | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log(d.casks[0].url)" 2>/dev/null || true)',
      'URL="${BREW_URL:-https://download.panic.com/transmit/Transmit%205.zip}"',
      'echo "Downloading Transmit from $URL"',
      'curl -fSL -L --retry 3 -H "User-Agent: $UA" "$URL" -o /tmp/transmit.zip',
      'cd /tmp && unzip -qo transmit.zip',
      'mkdir -p {{prefix}}',
      'APP=$(find /tmp -maxdepth 1 -name "Transmit*.app" | head -1)',
      '[ -n "$APP" ] || { echo "ERROR: Transmit.app was not produced"; exit 1; }',
      'mv "$APP" "{{prefix}}/Transmit.app"',
      'mkdir -p {{prefix}}/bin',
      'ln -sf "../Transmit.app/Contents/MacOS/Transmit" {{prefix}}/bin/transmit',
    ],
  },
}
