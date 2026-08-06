import type { BinaryStorage } from './server'
import { describe, expect, it } from 'bun:test'
import { invalidateBinaryMetadata, loadBinaryMetadata } from './server'

/**
 * The download path reads `binaries/<domain>/metadata.json` for the tarball and
 * again for the `.sha256`, and the CLI reads it once more to resolve a version.
 * Those manifests are the largest small object in the bucket (>100 KB for
 * ziglang.org) and the provider bills egress per byte, so the repeat reads were
 * a pure multiplier on the storage bill.
 */
function countingStore(domain: string, body: unknown): BinaryStorage & { reads: number } {
  let reads = 0
  return {
    get reads() { return reads },
    async getObject(key: string) {
      if (key !== `binaries/${domain}/metadata.json`)
        throw new Error(`unexpected key ${key}`)
      reads++
      return Buffer.from(JSON.stringify(body))
    },
  } as BinaryStorage & { reads: number }
}

describe('binary metadata memo', () => {
  it('reads the manifest once for repeat requests', async () => {
    const store = countingStore('cache-hit.example', { name: 'cache-hit.example' })
    invalidateBinaryMetadata('cache-hit.example')

    const first = await loadBinaryMetadata(store, 'cache-hit.example', true)
    const second = await loadBinaryMetadata(store, 'cache-hit.example', true)

    expect(first).toEqual({ name: 'cache-hit.example' })
    expect(second).toEqual({ name: 'cache-hit.example' })
    expect(store.reads).toBe(1)
  })

  it('re-reads after the domain is invalidated by a publish', async () => {
    const store = countingStore('invalidate.example', { name: 'invalidate.example' })
    invalidateBinaryMetadata('invalidate.example')

    await loadBinaryMetadata(store, 'invalidate.example', true)
    invalidateBinaryMetadata('invalidate.example')
    await loadBinaryMetadata(store, 'invalidate.example', true)

    expect(store.reads).toBe(2)
  })

  it('bypasses the memo when the caller opts out', async () => {
    const store = countingStore('no-cache.example', { name: 'no-cache.example' })
    invalidateBinaryMetadata('no-cache.example')

    await loadBinaryMetadata(store, 'no-cache.example', false)
    await loadBinaryMetadata(store, 'no-cache.example', false)

    expect(store.reads).toBe(2)
  })

  it('does not cache a failed read', async () => {
    let attempts = 0
    const store: BinaryStorage = {
      async getObject() {
        attempts++
        if (attempts === 1) throw new Error('NoSuchKey')
        return Buffer.from(JSON.stringify({ name: 'transient.example' }))
      },
    }
    invalidateBinaryMetadata('transient.example')

    await expect(loadBinaryMetadata(store, 'transient.example', true)).rejects.toThrow('NoSuchKey')
    expect(await loadBinaryMetadata(store, 'transient.example', true)).toEqual({ name: 'transient.example' })
  })
})
