import { describe, expect, test } from 'bun:test'
import { shouldUseLockedVersion, versionSatisfiesSpec } from './lock-version'

describe('versionSatisfiesSpec', () => {
  test('supports sentinels, exact versions, and common ranges', () => {
    expect(versionSatisfiesSpec('1.3.14', '*')).toBe(true)
    expect(versionSatisfiesSpec('1.3.14', '^1.3.10')).toBe(true)
    expect(versionSatisfiesSpec('2.0.0', '^1.3.10')).toBe(false)
    expect(versionSatisfiesSpec('0.15.15', '~0.15.10')).toBe(true)
    expect(versionSatisfiesSpec('0.16.0', '~0.15.10')).toBe(false)
    expect(versionSatisfiesSpec(
      '0.17.0-dev.956+2dca73595',
      '0.17.0-dev.1413+addc3c3b8',
    )).toBe(false)
  })
})

describe('shouldUseLockedVersion', () => {
  test('does not freeze a rolling Zig development channel', () => {
    expect(shouldUseLockedVersion(
      'ziglang.org',
      '0.17.0-dev.131+73c51c142',
      '0.17.0-dev',
    )).toBe(false)
  })

  test('preserves exact Zig development pins and ordinary lock entries', () => {
    expect(shouldUseLockedVersion(
      'ziglang.org',
      '0.17.0-dev.956+2dca73595',
      '0.17.0-dev.956+2dca73595',
    )).toBe(true)
    expect(shouldUseLockedVersion('bun.sh', '1.3.14', '^1.3.10')).toBe(true)
  })
})
