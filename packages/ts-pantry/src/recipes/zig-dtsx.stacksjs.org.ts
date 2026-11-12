import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'zig-dtsx.stacksjs.org',
  name: 'zig-dtsx',
  description: 'High-performance .d.ts emitter for TypeScript, written in Zig. The standalone CLI is distributed separately from the zig-dtsx JavaScript FFI package.',
  homepage: 'https://github.com/stacksjs/dtsx#readme',
  github: 'https://github.com/stacksjs/dtsx',
  programs: ['zig-dtsx'],
  platforms: ['darwin/aarch64', 'linux/aarch64', 'linux/x86-64'],
  buildDependencies: {
    'curl.se': '*',
    'info-zip.org/unzip': '*',
    'gnu.org/coreutils': '*',
  },
  publish: { include: ['bin/zig-dtsx'] },

  versionSource: {
    type: 'github-releases',
    repo: 'stacksjs/dtsx',
    tagPattern: /^v(.+)$/,
    stable: true,
  },

  build: {
    script: [
      'case {{hw.platform}}+{{hw.arch}} in',
      '  darwin+aarch64) PLATFORM="darwin-arm64" ;;',
      '  linux+aarch64)  PLATFORM="linux-arm64" ;;',
      '  linux+x86-64)   PLATFORM="linux-x64"   ;;',
      '  *)              echo "unsupported platform: {{hw.platform}}+{{hw.arch}}" >&2; exit 1 ;;',
      'esac',
      '',
      'ASSET="zig-dtsx-${PLATFORM}.zip"',
      'RELEASE="https://github.com/stacksjs/dtsx/releases/download/v{{version}}"',
      'curl -fSL --connect-timeout 30 --max-time 300 "$RELEASE/$ASSET" -o "$ASSET"',
      'curl -fSL --connect-timeout 30 --max-time 300 "$RELEASE/checksums.txt" -o checksums.txt',
      'awk -v name="$ASSET" \'$2 == name { if (NF != 2 || length($1) != 64 || $1 ~ /[^0-9a-fA-F]/) exit 1; print; found++ } END { if (found != 1) exit 1 }\' checksums.txt > artifact.sha256',
      'sha256sum --check artifact.sha256',
      'unzip -q "$ASSET" zig-dtsx',
      'mkdir -p "{{prefix}}/bin"',
      'install -m755 zig-dtsx "{{prefix}}/bin/zig-dtsx"',
    ],
  },
  test: {
    required: true,
    script: ['printf \'export const answer = 42;\\n\' | zig-dtsx | grep -F \'export declare const answer: 42;\''],
  },
}
