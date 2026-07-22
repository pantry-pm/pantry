import { describe, expect, it } from 'bun:test'
import { downloadReleaseAssetReliably, isRetryableReleaseDownloadError } from './release-download'

describe('release asset downloads', () => {
  it('retries a tag whose release asset is still publishing', async () => {
    let attempts = 0
    const warnings: string[] = []

    const path = await downloadReleaseAssetReliably('Pantry 0.10.43 linux-x64', async () => {
      attempts += 1
      if (attempts < 3) throw new Error('Unexpected HTTP response: 404')
      return '/tmp/pantry.zip'
    }, {
      sleep: async () => {},
      onRetry: warning => warnings.push(warning),
    })

    expect(path).toBe('/tmp/pantry.zip')
    expect(attempts).toBe(3)
    expect(warnings).toHaveLength(2)
  })

  it('does not retry authorization or malformed-request failures', async () => {
    let attempts = 0
    await expect(downloadReleaseAssetReliably('Pantry 0.10.43 linux-x64', async () => {
      attempts += 1
      throw new Error('Unexpected HTTP response: 403')
    }, { sleep: async () => {} })).rejects.toThrow('Unexpected HTTP response: 403')

    expect(attempts).toBe(1)
    expect(isRetryableReleaseDownloadError(new Error('Unexpected HTTP response: 400'))).toBe(false)
    expect(isRetryableReleaseDownloadError(Object.assign(new Error('Unexpected HTTP response: 404'), { status: undefined }))).toBe(true)
  })

  it('caps backoff and reports the requested release after exhaustion', async () => {
    const delays: number[] = []
    await expect(downloadReleaseAssetReliably('Pantry 0.10.43 windows-x64', async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 })
    }, {
      maxAttempts: 5,
      retryDelayMs: 10000,
      sleep: async (delay) => { delays.push(delay) },
    })).rejects.toThrow('Pantry 0.10.43 windows-x64 remained unavailable after 5 attempts')

    expect(delays).toEqual([10000, 20000, 30000, 30000])
  })
})
