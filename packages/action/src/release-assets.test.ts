import { describe, expect, test } from 'bun:test'
import { preferArchivedReleaseAssets, rawAssetNamesForArchives, resolveReleaseFilePatterns } from './release-assets'

describe('resolveReleaseFilePatterns', () => {
  test('auto-packages when the input is empty or auto', () => {
    expect(resolveReleaseFilePatterns('')).toBeNull()
    expect(resolveReleaseFilePatterns('auto')).toBeNull()
  })

  test('supports notes-only releases', () => {
    expect(resolveReleaseFilePatterns('none')).toEqual([])
  })

  test('returns explicit newline-separated patterns', () => {
    expect(resolveReleaseFilePatterns('dist/*.zip\n checksums.txt ')).toEqual([
      'dist/*.zip',
      'checksums.txt',
    ])
  })
})

describe('preferArchivedReleaseAssets', () => {
  test('keeps only archives when matching raw binaries are present', () => {
    expect(preferArchivedReleaseAssets([
      'bin/buddy-darwin-arm64',
      'bin/buddy-darwin-arm64.zip',
      'bin/buddy-windows-x64.exe',
      'bin/buddy-windows-x64.zip',
    ])).toEqual([
      'bin/buddy-darwin-arm64.zip',
      'bin/buddy-windows-x64.zip',
    ])
  })

  test('preserves standalone assets and removes duplicate matches', () => {
    expect(preferArchivedReleaseAssets([
      'dist/tool.zip',
      'dist/tool.zip',
      'dist/checksums.txt',
      'dist/installer.dmg',
    ])).toEqual([
      'dist/tool.zip',
      'dist/checksums.txt',
      'dist/installer.dmg',
    ])
  })

  test('does not suppress a same-named binary from another directory', () => {
    expect(preferArchivedReleaseAssets([
      'debug/tool',
      'release/tool.zip',
    ])).toEqual([
      'debug/tool',
      'release/tool.zip',
    ])
  })
})

describe('rawAssetNamesForArchives', () => {
  test('identifies Unix and Windows binaries superseded by archives', () => {
    expect([...rawAssetNamesForArchives([
      'dist/buddy-linux-x64.zip',
      'dist/buddy-windows-x64.tar.gz',
      'dist/checksums.txt',
    ])]).toEqual([
      'buddy-linux-x64',
      'buddy-linux-x64.exe',
      'buddy-windows-x64',
      'buddy-windows-x64.exe',
    ])
  })
})
