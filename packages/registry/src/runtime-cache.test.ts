import { describe, expect, it } from 'bun:test'
import { BoundedAsyncCache, BoundedTtlCache } from './runtime-cache'

describe('bounded runtime caches', () => {
  it('expires entries at the configured TTL', () => {
    let now = 1_000
    const cache = new BoundedTtlCache<string, number>(2, 100, () => now)
    cache.set('one', 1)
    expect(cache.get('one')).toBe(1)
    now += 100
    expect(cache.get('one')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('evicts the least recently used entry at its hard bound', () => {
    const cache = new BoundedTtlCache<string, number>(2, 1_000)
    cache.set('one', 1)
    cache.set('two', 2)
    expect(cache.get('one')).toBe(1)
    cache.set('three', 3)
    expect(cache.get('two')).toBeUndefined()
    expect(cache.get('one')).toBe(1)
    expect(cache.get('three')).toBe(3)
    expect(cache.size).toBe(2)
  })

  it('supports explicit invalidation', () => {
    const cache = new BoundedTtlCache<string, number>(2, 1_000)
    cache.set('one', 1)
    expect(cache.delete('one')).toBeTrue()
    expect(cache.get('one')).toBeUndefined()
  })

  it('coalesces concurrent loads for the same key', async () => {
    const cache = new BoundedAsyncCache<string, number>(2, 1_000)
    let loads = 0
    const load = async (): Promise<number> => {
      loads++
      await Bun.sleep(5)
      return 42
    }
    const [first, second, third] = await Promise.all([
      cache.getOrCreate('answer', load),
      cache.getOrCreate('answer', load),
      cache.getOrCreate('answer', load),
    ])
    expect([first, second, third]).toEqual([42, 42, 42])
    expect(loads).toBe(1)
    expect(await cache.getOrCreate('answer', load)).toBe(42)
    expect(loads).toBe(1)
  })

  it('does not cache rejected loads', async () => {
    const cache = new BoundedAsyncCache<string, number>(2, 1_000)
    let loads = 0
    const load = async (): Promise<number> => {
      loads++
      if (loads === 1) throw new Error('temporary')
      return 42
    }
    await expect(cache.getOrCreate('answer', load)).rejects.toThrow('temporary')
    expect(await cache.getOrCreate('answer', load)).toBe(42)
    expect(loads).toBe(2)
  })
})
