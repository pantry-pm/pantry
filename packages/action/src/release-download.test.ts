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

  it('retries a connection that drops mid-download', async () => {
    let attempts = 0

    const path = await downloadReleaseAssetReliably('Pantry 0.10.47 linux-x64', async () => {
      attempts += 1
      // What a dropped keep-alive connection actually reports. It carries no
      // HTTP status, so before this was retryable the whole run failed here.
      if (attempts < 3) throw new Error('socket hang up')
      return '/tmp/pantry.zip'
    }, { sleep: async () => {} })

    expect(path).toBe('/tmp/pantry.zip')
    expect(attempts).toBe(3)
  })

  it('treats network failures as retryable, by code or by message', () => {
    expect(isRetryableReleaseDownloadError(new Error('socket hang up'))).toBe(true)
    expect(isRetryableReleaseDownloadError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isRetryableReleaseDownloadError(Object.assign(new Error('getaddrinfo EAI_AGAIN github.com'), { code: 'EAI_AGAIN' }))).toBe(true)
    expect(isRetryableReleaseDownloadError(new Error('Client network socket disconnected before secure TLS connection was established'))).toBe(true)
  })

  it('finds the reason a fetch failure hides in its cause', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const error = Object.assign(new Error('fetch failed'), { cause })

    expect(isRetryableReleaseDownloadError(error)).toBe(true)
  })

  it('still refuses to retry a request that will never succeed', () => {
    expect(isRetryableReleaseDownloadError(new Error('Unexpected HTTP response: 401'))).toBe(false)
    expect(isRetryableReleaseDownloadError(new Error('Bad credentials'))).toBe(false)
    expect(isRetryableReleaseDownloadError(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))).toBe(false)
  })
})
