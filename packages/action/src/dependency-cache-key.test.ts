import { describe, expect, it } from 'bun:test'
import { dependencyCacheKeys } from './dependency-cache-key'
import type { Platform } from './types'

const platform: Platform = { os: 'linux', arch: 'x64', binaryName: 'pantry', assetName: 'pantry-linux-x86-64.zip' }
const keys = (digest: string, version = '0.11.117', target = platform) =>
  dependencyCacheKeys(target, digest, version, 'lock', 'deps', 'ziglang.org')

describe('dependency cache reuse', () => {
  it('reuses identical artifacts across CLI releases through a prefix hit', () => {
    const previous = keys('digest', '0.11.116')
    const current = keys('digest')
    expect(current.key).not.toBe(previous.key)
    expect(current.restoreKeys.some(prefix => previous.key.startsWith(prefix))).toBe(true)
  })

  it('cannot restore rebuilt artifacts or another platform', () => {
    const current = keys('digest')
    const incompatible = [
      keys('rebuilt').key,
      keys('digest', '0.11.116', { ...platform, arch: 'arm64' }).key,
      keys('digest', '0.11.116', { ...platform, os: 'darwin' }).key,
    ]
    for (const key of incompatible)
      expect(current.restoreKeys.some(prefix => key.startsWith(prefix))).toBe(false)
  })

  it('cannot restore historical whole-workspace archives into a native prefix cache', () => {
    const previous = [
      'pantry-v4-0.11.117-linux-x64-digest-lock-deps-ziglang.org',
      'pantry-v5-linux-x64-digest-0.11.117-lock-deps-ziglang.org',
    ]
    for (const key of previous)
      expect(keys('digest').restoreKeys.some(prefix => key.startsWith(prefix))).toBe(false)
  })
})
