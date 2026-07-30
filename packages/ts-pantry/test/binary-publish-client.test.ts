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
