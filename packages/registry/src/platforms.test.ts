import { describe, expect, it } from 'bun:test'
import { ALL_PLATFORMS, BUILDABLE_PLATFORMS, isRetiredPlatform, RETIRED_PLATFORMS } from './platforms'

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

  /**
   * The registry is bundled standalone (`rootDir: ./src`), so it keeps its own
   * copy of the vocabulary rather than importing the build side's. That is only
   * safe while something checks the two still say the same thing — retiring a
   * platform on one side and not the other is precisely the split that made two
   * thirds of the registry's "incomplete" rows meaningless.
   *
   * Read as text rather than imported, for the same boundary reason.
   */
  it('says the same thing as the build side', async () => {
    const source = await Bun.file(
      new URL('../../ts-pantry/src/platforms.ts', import.meta.url),
    ).text()

    const listIn = (name: string): string[] => {
      const line = source.split('\n').find(l => l.startsWith(`export const ${name} = [`))
      if (!line)
        throw new Error(`ts-pantry/src/platforms.ts has no ${name}`)
      const body = line.slice(line.indexOf('[') + 1, line.lastIndexOf(']'))
      return body.split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(Boolean)
    }

    expect(listIn('ALL_PLATFORMS')).toEqual([...ALL_PLATFORMS])
    expect(listIn('RETIRED_PLATFORMS')).toEqual([...RETIRED_PLATFORMS])
    expect(listIn('BUILDABLE_PLATFORMS')).toEqual([...BUILDABLE_PLATFORMS])
  })
})
