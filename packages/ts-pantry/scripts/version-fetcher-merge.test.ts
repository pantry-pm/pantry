import { describe, expect, test } from 'bun:test'
import { mergeCatalogVersions, sortVersionsDesc } from './version-fetcher'

describe('sortVersionsDesc', () => {
  test('orders newest first by dotted-numeric value', () => {
    expect(sortVersionsDesc(['1.9.4', '1.10.0', '1.9.10'])).toEqual(['1.10.0', '1.9.10', '1.9.4'])
  })

  test('a release outranks a prerelease at equal numerics', () => {
    expect(sortVersionsDesc(['5.44.0-RC2', '5.44.0'])).toEqual(['5.44.0', '5.44.0-RC2'])
  })
})

describe('mergeCatalogVersions', () => {
  test('adds at most `limit` of the newest incoming versions', () => {
    const incoming = Array.from({ length: 50 }, (_, i) => `1.0.${50 - i}`)
    const { versions, added } = mergeCatalogVersions([], incoming, 20)
    expect(added).toHaveLength(20)
    expect(versions[0]).toBe('1.0.50')
    // The window is the NEWEST twenty, not the first twenty upstream handed us.
    expect(versions).not.toContain('1.0.30')
  })

  test('takes the newest even when upstream hands them over out of order', () => {
    const { added } = mergeCatalogVersions([], ['1.0.1', '9.9.9', '2.0.0'], 2)
    expect(added).toEqual(['9.9.9', '2.0.0'])
  })

  // Some catalog entries are already published; delisting one would break
  // installs of it. Growth is bounded, history is not discarded.
  test('never removes a version already in the catalog', () => {
    const { versions } = mergeCatalogVersions(['0.0.1', '0.0.2'], ['9.0.0'], 1)
    expect(versions).toContain('0.0.1')
    expect(versions).toContain('0.0.2')
    expect(versions).toContain('9.0.0')
  })

  test('reports nothing added when upstream is already covered', () => {
    const { added } = mergeCatalogVersions(['1.0.0'], ['1.0.0'], 20)
    expect(added).toEqual([])
  })
})
