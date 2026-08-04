import { describe, expect, it } from 'bun:test'
import { completeBinaryUpload } from '../scripts/binary-publish-client'

const auth = { Authorization: 'Bearer test' }

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

describe('binary upload completion', () => {
  it('reconciles a lost response while the idempotent completion is still running', async () => {
    const responses: Array<Response | Error> = [
      new Error('socket closed after request'),
      jsonResponse({
        code: 'BINARY_STAGING_NOT_FOUND',
        error: 'Staged artifact was not found or has expired',
      }, 404),
      new Response('upstream unavailable', { status: 503 }),
      jsonResponse({
        success: true,
        scan: { verdict: 'clean', artifactSha256: 'a'.repeat(64) },
      }),
    ]
    const delays: number[] = []
    const fetch = async () => {
      const response = responses.shift()
      if (response instanceof Error) throw response
      return response!
    }

    const completed = await completeBinaryUpload(
      'https://registry.example',
      'signed-upload',
      auth,
      {
        fetch,
        sleep: async milliseconds => void delays.push(milliseconds),
      },
    )

    expect(completed.scan.verdict).toBe('clean')
    expect(responses).toHaveLength(0)
    expect(delays).toEqual([1000, 2000, 4000])
  })

  it('does not retry an explicit malware verdict', async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      return jsonResponse({
        code: 'MALWARE_DETECTED',
        error: 'Binary artifact blocked by malware scanning',
      }, 422)
    }

    await expect(completeBinaryUpload(
      'https://registry.example',
      'signed-upload',
      auth,
      { fetch, sleep: async () => {} },
    )).rejects.toThrow('MALWARE_DETECTED')
    expect(calls).toBe(1)
  })

  it('bounds ambiguous completion polling', async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      throw new Error('connection reset')
    }

    await expect(completeBinaryUpload(
      'https://registry.example',
      'signed-upload',
      auth,
      { attempts: 3, fetch, sleep: async () => {} },
    )).rejects.toThrow('remained ambiguous after 3 attempts')
    expect(calls).toBe(3)
  })
})

describe('completion waits long enough for a large artifact to be scanned', () => {
  // A 273MB package failed to publish because the client gave up after ~5
  // minutes (15 attempts, backoff capped at 30s) while the registry was still
  // scanning. The build had succeeded; only the wait was too short.
  it('keeps polling past the old 15-attempt budget', async () => {
    let calls = 0
    const fetch = (async () => {
      calls++
      // Mid-scan: staging is already sealed and deleted, promotion not yet
      // recorded. This is the ambiguous-but-retryable state.
      if (calls < 25) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({ code: 'BINARY_STAGING_NOT_FOUND', error: 'Staged artifact was not found or has expired' }),
        }
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ success: true, domain: 'vitess.io' }) }
    }) as any

    const result = await completeBinaryUpload('https://registry.test', 'upload-1', { Authorization: 'Bearer t' }, {
      fetch,
      sleep: async () => {},
    })
    expect(result.success).toBe(true)
    expect(calls).toBe(25)
  })

  it('stops at the deadline even with attempts left', async () => {
    // The wait is bounded by time, not poll count: what varies is how long a
    // scan takes, not how many times we asked.
    let now = 0
    const realNow = Date.now
    Date.now = () => now
    try {
      const fetch = (async () => {
        now += 60_000
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({ code: 'BINARY_STAGING_NOT_FOUND', error: 'gone' }),
        }
      }) as any
      await expect(completeBinaryUpload('https://registry.test', 'u', { Authorization: 'Bearer t' }, {
        fetch,
        sleep: async () => {},
        deadlineMs: 5 * 60_000,
      })).rejects.toThrow('remained ambiguous')
    }
    finally {
      Date.now = realNow
    }
  })

  it('still fails fast on a permanent error', async () => {
    // A budget increase must not turn a real rejection into a long hang.
    const fetch = (async () => ({
      ok: false,
      status: 422,
      statusText: 'Unprocessable',
      json: async () => ({ code: 'BINARY_SIZE_MISMATCH', error: 'size mismatch' }),
    })) as any
    await expect(completeBinaryUpload('https://registry.test', 'u', { Authorization: 'Bearer t' }, {
      fetch,
      sleep: async () => {},
    })).rejects.toThrow('BINARY_SIZE_MISMATCH')
  })
})

describe('a failed publish explains itself', () => {
  // A bare MALWARE_SCAN_UNAVAILABLE says only "fail closed". Working out why a
  // 183MB artifact failed meant querying the registry's metrics endpoint after
  // the fact and inferring the cause from durationMs.max. The verdict, reason
  // and duration are in the response already.
  it('includes the scanner verdict, reason and duration in the error', async () => {
    const fetch = async () => jsonResponse({
      code: 'MALWARE_SCAN_UNAVAILABLE',
      error: 'Binary artifact malware scanning is temporarily unavailable',
      retryable: true,
      scan: { verdict: 'error', reason: 'isolated scanner timed out after 270000ms', durationMs: 270005 },
    }, 503)

    const failure = await completeBinaryUpload('https://registry.test', 'upload-1', auth, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      attempts: 1,
      sleep: async () => {},
    }).catch((error: Error) => error)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('MALWARE_SCAN_UNAVAILABLE')
    expect(message).toContain('verdict=error')
    expect(message).toContain('isolated scanner timed out after 270000ms')
    expect(message).toContain('durationMs=270005')
  })

  it('says nothing extra when there is no scan to report', async () => {
    const fetch = async () => jsonResponse({
      code: 'BINARY_SIZE_MISMATCH',
      error: 'Staged artifact size does not match the initiated upload',
    }, 422)

    const failure = await completeBinaryUpload('https://registry.test', 'upload-1', auth, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      attempts: 1,
      sleep: async () => {},
    }).catch((error: Error) => error)

    expect((failure as Error).message).toBe(
      'BINARY_SIZE_MISMATCH: Staged artifact size does not match the initiated upload',
    )
  })
})
