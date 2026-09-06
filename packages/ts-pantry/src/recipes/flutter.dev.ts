import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'flutter.dev',
  name: 'flutter',
  description: 'Flutter makes it easy and fast to build beautiful apps for mobile and beyond',
  homepage: 'https://flutter.dev',
  github: 'https://github.com/flutter/flutter',
  programs: ['flutter', 'dart'],
  platforms: ['darwin', 'linux/x86-64'],
  versionSource: {
    // flutter/flutter's releases are `3.19.0-0.1.pre` betas; the stable
    // versions the DIST urls below are keyed on live in the same releases
    // index the official installer reads.
    type: 'custom',
    async fetch() {
      const resp = await fetch(
        'https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json',
        { headers: { 'User-Agent': 'pantry-version-fetcher' }, signal: AbortSignal.timeout(30000) },
      )
      if (!resp.ok)
        return []
      const index = await resp.json() as { releases?: Array<{ version?: string, channel?: string }> }
      const seen = new Set<string>()
      for (const release of index.releases ?? []) {
        if (release.channel !== 'stable' || typeof release.version !== 'string')
          continue
        // Stable channel still carries the odd `-pre`; the tarballs we fetch
        // are named for plain releases only.
        if (/^\d+\.\d+\.\d+$/.test(release.version))
          seen.add(release.version)
      }
      return [...seen].sort((a, b) => {
        const x = a.split('.').map(Number)
        const y = b.split('.').map(Number)
        return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2])
      })
    },
  },
  dependencies: {
    'git-scm.org': '*',
    'tukaani.org/xz': '*',
    'gnu.org/which': '*', // flutter create uses which
    linux: {
      'curl.se': '*',
      'info-zip.org/zip': '*',
      'info-zip.org/unzip': '*',
    },
  },

  build: {
    workingDirectory: '{{prefix}}',
    env: {
      linux: {
        DIST: 'https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_{{version}}-stable.tar.xz',
      },
      'darwin/aarch64': {
        DIST: 'https://storage.googleapis.com/flutter_infra_release/releases/stable/macos/flutter_macos_arm64_{{version}}-stable.zip',
      },
      'darwin/x86-64': {
        DIST: 'https://storage.googleapis.com/flutter_infra_release/releases/stable/macos/flutter_macos_{{version}}-stable.zip',
      },
    },
    script: [
      {
        run: 'curl -L "$DIST" | tar Jxf -',
        if: 'linux',
      },
      {
        run: [
          'curl -o flutter_darwin.zip "$DIST"',
          'unzip flutter_darwin.zip',
          'rm flutter_darwin.zip',
        ],
        if: 'darwin',
      },
      {
        run: [
          'ln -s ../flutter/bin/flutter flutter',
          'ln -s ../flutter/bin/dart dart',
        ],
        'working-directory': '{{prefix}}/bin',
      },
    ],
  },
}
