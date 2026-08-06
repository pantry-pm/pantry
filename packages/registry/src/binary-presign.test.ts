import { describe, expect, it } from 'bun:test'
import { presignBinaryDownload } from './server'

function recordingClient() {
  const calls: { key: string, expiresInSeconds?: number, signedAt?: Date }[] = []
  return {
    calls,
    generatePresignedGetUrl(_bucket: string, key: string, expiresInSeconds?: number, signedAt?: Date) {
      calls.push({ key, expiresInSeconds, signedAt })
      return `https://bucket.example/${key}?X-Amz-Date=${signedAt?.toISOString()}&X-Amz-Expires=${expiresInSeconds}`
    },
  }
}

const HOUR = 60 * 60 * 1000

describe('presignBinaryDownload', () => {
  it('returns a byte-identical URL for every caller inside the same window', () => {
    const client = recordingClient()
    const base = 1_800_000_000_000

    const first = presignBinaryDownload(client, 'pantry-registry', 'binaries/a/1.0/linux-x86-64/a.tar.gz', base)
    const second = presignBinaryDownload(client, 'pantry-registry', 'binaries/a/1.0/linux-x86-64/a.tar.gz', base + 59 * 60 * 1000)

    expect(second.url).toBe(first.url)
    expect(client.calls[0].signedAt).toEqual(client.calls[1].signedAt)
  })

  it('rolls to a new URL once the window advances', () => {
    const client = recordingClient()
    const base = 1_800_000_000_000

    const first = presignBinaryDownload(client, 'pantry-registry', 'binaries/a/1.0/linux-x86-64/a.tar.gz', base)
    const next = presignBinaryDownload(client, 'pantry-registry', 'binaries/a/1.0/linux-x86-64/a.tar.gz', base + HOUR)

    expect(next.url).not.toBe(first.url)
  })

  it('never advertises a cache lifetime that outlives the signature', () => {
    const client = recordingClient()
    const base = Math.floor(1_800_000_000_000 / HOUR) * HOUR

    for (const offsetMinutes of [0, 1, 30, 59]) {
      const at = base + offsetMinutes * 60 * 1000
      const { maxAgeSeconds } = presignBinaryDownload(client, 'pantry-registry', 'binaries/a/1.0/linux-x86-64/a.tar.gz', at)
      const signedAt = client.calls.at(-1)!.signedAt!.getTime()
      const expiresAt = signedAt + client.calls.at(-1)!.expiresInSeconds! * 1000
      expect(at + maxAgeSeconds * 1000).toBeLessThan(expiresAt)
    }
  })

  it('signs for the full window-aligned lifetime', () => {
    const client = recordingClient()
    presignBinaryDownload(client, 'pantry-registry', 'binaries/a/1.0/linux-x86-64/a.tar.gz', 1_800_000_000_000)
    expect(client.calls[0].expiresInSeconds).toBe(24 * 60 * 60)
  })
})
