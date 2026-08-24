import { describe, expect, it } from 'bun:test'
import { registryVersionsForPlatform, sqliteOfficialDownloadUrl, ziglangOfficialDownload, zigRegistryMirror } from '../src/installer'

describe('registry platform version resolution', () => {
  const metadata = {
    versions: {
      '0.17.0-dev.1552_79dc16a0e': {
        platforms: {
          'darwin-arm64': {},
          'linux-x86-64': {},
        },
      },
      '0.17.0-dev.1564_97ced1272': {
        platforms: {
          'darwin-arm64': {},
        },
      },
    },
  }

  it('only returns versions published for the requested target', () => {
    expect(registryVersionsForPlatform(metadata, { os: 'linux', arch: 'x86_64' }))
      .toEqual(['0.17.0-dev.1552_79dc16a0e'])
  })

  it('uses the registry platform spelling for ARM targets', () => {
    expect(registryVersionsForPlatform(metadata, { os: 'darwin', arch: 'aarch64' }))
      .toEqual(['0.17.0-dev.1552_79dc16a0e', '0.17.0-dev.1564_97ced1272'])
  })
})

describe('official Zig fallback downloads', () => {
  it('normalizes Pantry dev versions for upstream macOS archives', () => {
    expect(ziglangOfficialDownload('0.17.0-dev.1509_bb296ab9b', { os: 'darwin', arch: 'aarch64' })).toEqual({
      url: 'https://ziglang.org/builds/zig-aarch64-macos-0.17.0-dev.1509+bb296ab9b.tar.xz',
      format: 'tar.xz',
      prefix: 'zig-aarch64-macos-0.17.0-dev.1509+bb296ab9b',
    })
  })

  it('uses versioned stable Windows downloads', () => {
    expect(ziglangOfficialDownload('0.15.2', { os: 'windows', arch: 'x86_64' }).url)
      .toBe('https://ziglang.org/download/0.15.2/zig-x86_64-windows-0.15.2.zip')
  })
})

describe('Zig registry mirror selection', () => {
  // linux-arm64 mirrors an older dev build than the other targets — and
  // ziglang.org has long since deleted that archive, so upstream is a 404.
  const metadata = {
    versions: {
      '0.17.0-dev.1282+c0f9b51d8': {
        platforms: { 'darwin-arm64': {}, 'linux-arm64': {}, 'linux-x86-64': {} },
      },
      '0.17.0-dev.1282_c0f9b51d8': {
        platforms: { 'darwin-arm64': {}, 'linux-x86-64': {} },
      },
      '0.17.0-dev.1859_dcceb318e': {
        platforms: { 'darwin-arm64': {}, 'linux-x86-64': {} },
      },
    },
  }

  it('downloads a mirrored dev build from the registry, not upstream', () => {
    const source = zigRegistryMirror(metadata, '0.17.0-dev.1859_dcceb318e', { os: 'linux', arch: 'x86_64' })
    expect(source).toEqual({
      url: 'https://registry.pantry.dev/binaries/ziglang.org/0.17.0-dev.1859_dcceb318e/linux-x86-64/ziglang.org-0.17.0-dev.1859_dcceb318e.tar.gz',
      format: 'tar.gz',
      prefix: '',
    })
  })

  // The registry keys some dev builds with '+' and others with '_', and only
  // one spelling may carry a given platform's artifact.
  it('finds the artifact under whichever hash spelling the registry indexed', () => {
    const source = zigRegistryMirror(metadata, '0.17.0-dev.1282_c0f9b51d8', { os: 'linux', arch: 'aarch64' })
    expect(source?.url).toBe(
      'https://registry.pantry.dev/binaries/ziglang.org/0.17.0-dev.1282+c0f9b51d8/linux-arm64/ziglang.org-0.17.0-dev.1282+c0f9b51d8.tar.gz',
    )
  })

  it('leaves tagged releases on ziglang.org so we do not pay egress for them', () => {
    expect(zigRegistryMirror(metadata, '0.15.2', { os: 'linux', arch: 'x86_64' })).toBeNull()
  })

  it('falls back to upstream when the registry has no artifact for the target', () => {
    expect(zigRegistryMirror(metadata, '0.17.0-dev.1859_dcceb318e', { os: 'linux', arch: 'aarch64' })).toBeNull()
    expect(zigRegistryMirror(null, '0.17.0-dev.1859_dcceb318e', { os: 'linux', arch: 'x86_64' })).toBeNull()
  })
})

describe('official SQLite tool downloads', () => {
  it('builds the current macOS ARM archive URL', () => {
    expect(sqliteOfficialDownloadUrl('3.53.4', { os: 'darwin', arch: 'aarch64' }))
      .toBe('https://sqlite.org/2026/sqlite-tools-osx-arm64-3530400.zip')
  })

  it('builds the minimum supported Linux archive URL', () => {
    expect(sqliteOfficialDownloadUrl('3.47.2', { os: 'linux', arch: 'x86_64' }))
      .toBe('https://sqlite.org/2024/sqlite-tools-linux-x64-3470200.zip')
  })
})
