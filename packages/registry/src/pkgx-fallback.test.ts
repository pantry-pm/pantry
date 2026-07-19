import { describe, expect, it } from 'bun:test'
import { augmentMetadataWithPkgx } from './pkgx-fallback'

describe('pkgx metadata augmentation cache', () => {
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
})
