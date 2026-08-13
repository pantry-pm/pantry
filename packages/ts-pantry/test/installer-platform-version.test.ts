import { describe, expect, it } from 'bun:test'
import { registryVersionsForPlatform, sqliteOfficialDownloadUrl, ziglangOfficialDownload } from '../src/installer'

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
