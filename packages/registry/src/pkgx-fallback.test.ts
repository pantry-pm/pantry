import { describe, expect, it } from 'bun:test'
import { augmentMetadataWithPkgx, isCustomBuildDomain, isQuarantinedFallback } from './pkgx-fallback'

describe('pkgx metadata augmentation cache', () => {
  it('never falls back to pkgx for Pantry custom builds', () => {
    expect(isCustomBuildDomain('curl.se')).toBe(true)
    expect(isCustomBuildDomain('bun.com')).toBe(false)
  })

  it('invalidates cached augmentation when published metadata changes', async () => {
    const domain = `cache-refresh-${crypto.randomUUID()}.example`
    const first = await augmentMetadataWithPkgx(domain, {
      latestVersion: '1.0.0',
      updatedAt: '2026-07-19T20:00:00.000Z',
      versions: { '1.0.0': { platforms: {} } },
    }, [])
    const refreshed = await augmentMetadataWithPkgx(domain, {
      latestVersion: '2.0.0',
      updatedAt: '2026-07-19T21:00:00.000Z',
      versions: {
        '1.0.0': { platforms: {} },
        '2.0.0': { platforms: {} },
      },
    }, [])

    expect(first?.latestVersion).toBe('1.0.0')
    expect(refreshed?.latestVersion).toBe('2.0.0')
  })

  it('suppresses fallback for a durably quarantined version and platform', () => {
    const metadata = {
      malwareQuarantines: [{
        version: '2.0.1',
        platforms: ['darwin-x86-64'],
        artifactSha256: 'a'.repeat(64),
      }],
    }

    expect(isQuarantinedFallback(metadata, '2.0.1', 'darwin-x86-64')).toBe(true)
    expect(isQuarantinedFallback(metadata, '2.0.1', 'linux-x86-64')).toBe(false)
    expect(isQuarantinedFallback(metadata, '2.0.2', 'darwin-x86-64')).toBe(false)
  })
})
