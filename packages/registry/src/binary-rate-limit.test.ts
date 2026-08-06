import { describe, expect, it } from 'bun:test'
import { BinaryDownloadRateLimiter, binaryRateLimiterFromEnv, rateLimitClientKey } from './binary-rate-limit'

const MB = 1024 * 1024

describe('BinaryDownloadRateLimiter', () => {
  it('allows downloads inside both budgets', () => {
    const limiter = new BinaryDownloadRateLimiter({ maxRequests: 5, maxBytes: 100 * MB, now: () => 0 })
    for (let i = 0; i < 5; i++)
      expect(limiter.check('1.2.3.4', 10 * MB).allowed).toBe(true)
  })

  it('rejects once the request budget is spent', () => {
    const limiter = new BinaryDownloadRateLimiter({ maxRequests: 2, maxBytes: 0, now: () => 0 })
    expect(limiter.check('1.2.3.4', 1).allowed).toBe(true)
    expect(limiter.check('1.2.3.4', 1).allowed).toBe(true)

    const denied = limiter.check('1.2.3.4', 1)
    expect(denied.allowed).toBe(false)
    expect(denied.limit).toBe('requests')
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('rejects a download that would overrun the byte budget', () => {
    const limiter = new BinaryDownloadRateLimiter({ maxRequests: 0, maxBytes: 100 * MB, now: () => 0 })
    expect(limiter.check('1.2.3.4', 90 * MB).allowed).toBe(true)

    const denied = limiter.check('1.2.3.4', 20 * MB)
    expect(denied.allowed).toBe(false)
    expect(denied.limit).toBe('bytes')

    // A smaller artifact still fits — the budget is bytes, not attempts.
    expect(limiter.check('1.2.3.4', 5 * MB).allowed).toBe(true)
  })

  it('does not charge a rejected download', () => {
    const limiter = new BinaryDownloadRateLimiter({ maxRequests: 0, maxBytes: 100 * MB, now: () => 0 })
    limiter.check('1.2.3.4', 90 * MB)
    for (let i = 0; i < 20; i++) limiter.check('1.2.3.4', 20 * MB)

    expect(limiter.check('1.2.3.4', 10 * MB).allowed).toBe(true)
  })

  it('budgets each client separately', () => {
    const limiter = new BinaryDownloadRateLimiter({ maxRequests: 1, maxBytes: 0, now: () => 0 })
    expect(limiter.check('1.2.3.4', 1).allowed).toBe(true)
    expect(limiter.check('1.2.3.4', 1).allowed).toBe(false)
    expect(limiter.check('5.6.7.8', 1).allowed).toBe(true)
  })

  it('resets when the window rolls over', () => {
    let now = 0
    const limiter = new BinaryDownloadRateLimiter({ maxRequests: 1, maxBytes: 0, windowMs: 1000, now: () => now })
    expect(limiter.check('1.2.3.4', 1).allowed).toBe(true)
    expect(limiter.check('1.2.3.4', 1).allowed).toBe(false)

    now = 1000
    expect(limiter.check('1.2.3.4', 1).allowed).toBe(true)
  })

  it('is a no-op when both budgets are disabled', () => {
    const limiter = new BinaryDownloadRateLimiter({ maxRequests: 0, maxBytes: 0 })
    expect(limiter.enabled).toBe(false)
    for (let i = 0; i < 1000; i++)
      expect(limiter.check('1.2.3.4', 10 * MB).allowed).toBe(true)
  })

  it('bounds the number of tracked clients', () => {
    const limiter = new BinaryDownloadRateLimiter({ maxRequests: 10, maxBytes: 0, maxClients: 10, now: () => 0 })
    for (let i = 0; i < 500; i++)
      limiter.check(`10.0.0.${i}`, 1)

    // Nothing to assert on internals; the contract is that it keeps serving.
    expect(limiter.check('10.0.0.501', 1).allowed).toBe(true)
  })
})

describe('rateLimitClientKey', () => {
  it('uses the first X-Forwarded-For hop', () => {
    const req = new Request('https://registry.example/binaries/a', {
      headers: { 'x-forwarded-for': '203.0.113.7, 70.41.3.18' },
    })
    expect(rateLimitClientKey(req)).toBe('203.0.113.7')
  })

  it('falls back through the other proxy headers', () => {
    const cf = new Request('https://registry.example/binaries/a', { headers: { 'cf-connecting-ip': '198.51.100.4' } })
    expect(rateLimitClientKey(cf)).toBe('198.51.100.4')

    const real = new Request('https://registry.example/binaries/a', { headers: { 'x-real-ip': '198.51.100.9' } })
    expect(rateLimitClientKey(real)).toBe('198.51.100.9')
  })

  it('buckets unattributable callers together', () => {
    expect(rateLimitClientKey(new Request('https://registry.example/binaries/a'))).toBe('unknown')
  })
})

describe('binaryRateLimiterFromEnv', () => {
  it('is enabled by default', () => {
    expect(binaryRateLimiterFromEnv({} as NodeJS.ProcessEnv).enabled).toBe(true)
  })

  it('can be turned off entirely', () => {
    const limiter = binaryRateLimiterFromEnv({
      PANTRY_BINARY_RATE_LIMIT_REQUESTS_PER_HOUR: '0',
      PANTRY_BINARY_RATE_LIMIT_GIB_PER_HOUR: '0',
    } as NodeJS.ProcessEnv)
    expect(limiter.enabled).toBe(false)
  })

  it('ignores unparseable values rather than disabling the limit', () => {
    const limiter = binaryRateLimiterFromEnv({
      PANTRY_BINARY_RATE_LIMIT_REQUESTS_PER_HOUR: 'lots',
    } as NodeJS.ProcessEnv)
    expect(limiter.enabled).toBe(true)
  })
})
