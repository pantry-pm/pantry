import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'dart.dev',
  name: 'dart',
  description: 'The Dart SDK, including the VM, JS and Wasm compilers, analysis, core libraries, and more.',
  homepage: 'https://dart.dev',
  github: 'https://github.com/dart-lang/sdk',
  programs: ['dart', 'dartaotruntime'],
  versionSource: {
    // dart-lang/sdk tags every internal package (`meta-v1.3.0-nullsafety.2`,
    // `analyzer-0.33.6+1`) and its release tags are not what the build uses —
    // the download below is keyed on the SDK version under dart-archive. Read
    // that bucket directly so the two agree, the same shape ziglang.org uses.
    type: 'custom',
    async fetch() {
      const resp = await fetch(
        'https://storage.googleapis.com/storage/v1/b/dart-archive/o?prefix=channels/stable/release/&delimiter=/&maxResults=1000',
        { headers: { 'User-Agent': 'pantry-version-fetcher' }, signal: AbortSignal.timeout(30000) },
      )
      if (!resp.ok)
        return []
      const listing = await resp.json() as { prefixes?: string[] }
      return (listing.prefixes ?? [])
        .map(prefix => prefix.split('/').filter(Boolean).pop() ?? '')
        .filter(version => /^\d+\.\d+\.\d+$/.test(version))
        .sort((a, b) => {
          const x = a.split('.').map(Number)
          const y = b.split('.').map(Number)
          return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2])
        })
    },
  },

  build: {
    script: [
      'OS=$(uname -s | tr "[:upper:]" "[:lower:]")',
      'ARCH=$(uname -m)',
      'case "$OS/$ARCH" in',
      '  darwin/arm64) SDK="dartsdk-macos-arm64-release.zip" ;;',
      '  darwin/x86_64) SDK="dartsdk-macos-x64-release.zip" ;;',
      '  linux/x86_64) SDK="dartsdk-linux-x64-release.zip" ;;',
      '  linux/aarch64) SDK="dartsdk-linux-arm64-release.zip" ;;',
      '  *) echo "Unsupported platform" && exit 1 ;;',
      'esac',
      'curl -fSL -o /tmp/dartsdk.zip "https://storage.googleapis.com/dart-archive/channels/stable/release/{{version}}/sdk/${SDK}"',
      'mkdir -p {{prefix}}/libexec {{prefix}}/bin',
      'unzip -qo /tmp/dartsdk.zip -d /tmp/dart-extract',
      'cp -r /tmp/dart-extract/dart-sdk/* {{prefix}}/libexec/',
      'ln -sf ../libexec/bin/dart {{prefix}}/bin/dart',
      'ln -sf ../libexec/bin/dartaotruntime {{prefix}}/bin/dartaotruntime 2>/dev/null || true',
    ],
    skip: ['fix-patchelf'],
  },
}
