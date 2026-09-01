import { describe, expect, it } from 'bun:test'
import { ALL_PLATFORMS, BUILDABLE_PLATFORMS, isRetiredPlatform, RETIRED_PLATFORMS } from './platforms'

/**
 * The three lists are written out so callers keep their literal types. That is
 * only safe while something checks they still agree — otherwise retiring a
 * platform in one and forgetting the other reproduces the split this module was
 * made to end.
 */
describe('platform vocabulary', () => {
  it('buildable is exactly everything that is not retired', () => {
    const expected: string[] = ALL_PLATFORMS.filter(p => !RETIRED_PLATFORMS.includes(p as never))
    expect([...BUILDABLE_PLATFORMS] as string[]).toEqual(expected)
  })

  it('every retired platform is a real platform', () => {
    for (const p of RETIRED_PLATFORMS)
      expect(ALL_PLATFORMS).toContain(p)
  })

  it('keeps at least one platform buildable', () => {
    // Retiring everything would make every completeness check vacuously true.
    expect(BUILDABLE_PLATFORMS.length).toBeGreaterThan(0)
  })

  it('agrees with isRetiredPlatform', () => {
    for (const p of ALL_PLATFORMS)
      expect(isRetiredPlatform(p)).toBe(RETIRED_PLATFORMS.includes(p as never))
  })
})
