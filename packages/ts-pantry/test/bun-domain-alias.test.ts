import { describe, expect, it } from 'bun:test'
import { getAllAliasOverrides } from '../src/alias-overrides'
import { aliases } from '../src/packages/aliases'
import { pantry } from '../src/packages/index'

/**
 * Bun's domain moved from bun.sh to bun.com.
 *
 * Two things have to stay true through that. The new name has to resolve, and
 * the old one has to keep resolving: `bun.sh` is what every deps.yaml and
 * lockfile already in the wild asks for, and a rename that breaks those is a
 * worse outcome than carrying the old name forever.
 */

describe('bun domain aliasing', () => {
  it('resolves every spelling to bun.com', () => {
    const resolve = (spec: string) => aliases[spec] ?? spec

    expect(resolve('bun')).toBe('bun.com')
    expect(resolve('bun.sh')).toBe('bun.com')
    expect(resolve('bun.com')).toBe('bun.com')
  })

  it('survives a regeneration, because the override says so', () => {
    // The generated alias table is rewritten wholesale when packages are
    // regenerated. The override is what puts these back, so asserting the
    // table alone would pass today and fail the next time anybody regenerates.
    const overrides = getAllAliasOverrides()

    expect(overrides.bun).toBe('bun.com')
    expect(overrides['bun.sh']).toBe('bun.com')
  })

  it('carries the versions that actually exist', () => {
    const bun = (pantry as any).buncom

    expect(bun.domain).toBe('bun.com')
    // 1.3.12 through 1.3.14 were released and missing here, which made
    // `bun: ^1.3.14` unsatisfiable: it failed with "No version of bun.sh
    // satisfies", on machines where 1.3.14 was the installed runtime.
    for (const version of ['1.3.12', '1.3.13', '1.3.14'])
      expect(bun.versions).toContain(version)

    // Deliberately not `expect(versions[0]).toBe('1.3.14')`. Pinning the head
    // of the list freezes the catalog at whatever shipped the day the test was
    // written, so the next bun release turns a healthy update into a red build.
    // What matters is that discovery is still running: the newest entry must
    // be at least as new as the versions this test names.
    expect(bun.versions.indexOf('1.3.14')).toBeLessThanOrEqual(bun.versions.indexOf('1.3.12'))
    expect(bun.versions[0] >= '1.3.14').toBe(true)
  })

  it('keeps the old lookup key working', () => {
    // Someone reaching for `pantry.bunsh` predates the move and should not
    // have to care that it happened.
    expect((pantry as any).bunsh?.domain).toBe('bun.com')
    expect((pantry as any).bunsh).toBe((pantry as any).buncom)
  })
})
