import { describe, expect, it } from 'bun:test'
import { rateLimitStream } from './scanner-worker'

describe('isolated scanner worker', () => {
  it('rate-limits object downloads without changing their bytes', async () => {
    let now = 0
    const sleeps: number[] = []
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2])
      yield new Uint8Array([3, 4])
    }
    const chunks: Uint8Array[] = []

    for await (const chunk of rateLimitStream(source(), 2, {
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
      },
    })) {
      chunks.push(chunk)
    }

    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(sleeps).toEqual([1000, 1000])
  })
})
