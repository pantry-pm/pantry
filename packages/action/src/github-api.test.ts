import { expect, test } from 'bun:test'
import { createGitHubApi } from '../../../.github/scripts/github-api'

function fixture(results: Array<Response | Error>, budgetMs = 30_000) {
  let time = 0
  let calls = 0
  const delays: number[] = []
  const api = createGitHubApi({ token: 'fixture-only', now: () => time,
    sleep: async ms => { delays.push(ms); time += ms },
    fetch: (async () => {
      calls++
      const result = results.shift()
      if (result instanceof Error) throw result
      if (!result) throw new Error('No response')
      return result
    }) as unknown as typeof fetch,
  })
  return { call: () => api('repos/owner/repo', {}, budgetMs), delays, calls: () => calls }
}

test('network and server failures retry with bounded exponential backoff', async () => {
  const f = fixture([new Error('connection reset'), new Response('', { status: 503 }), Response.json({ ok: true })])
  expect(await f.call()).toEqual({ ok: true })
  expect(f.delays).toEqual([1000, 2000])
  expect(f.calls()).toBe(3)
})

for (const status of [401, 403, 404, 422]) {
  test(`permanent HTTP ${status} is never retried`, async () => {
    const f = fixture([new Response('permission denied', { status })])
    await expect(f.call()).rejects.toThrow(`HTTP ${status}`)
    expect(f.calls()).toBe(1)
    expect(f.delays).toEqual([])
  })
}

for (const status of [403, 429]) {
  test(`rate-limited HTTP ${status} honors Retry-After`, async () => {
    const f = fixture([new Response('rate limit', { status, headers: { 'Retry-After': '3' } }), Response.json({ ok: true })])
    await f.call()
    expect(f.delays).toEqual([3000])
  })
}

test('rate-limit reset beyond the overall budget aborts without sleeping', async () => {
  const f = fixture([new Response('rate limit', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' } })])
  await expect(f.call()).rejects.toThrow('wait budget')
  expect(f.delays).toEqual([])
})

test('network failures exhaust four attempts and never expose token details', async () => {
  const f = fixture(Array.from({ length: 4 }, () => new Error('fixture-only')))
  await expect(f.call()).rejects.toThrow('failed after bounded retries')
  expect(f.calls()).toBe(4)
  expect(f.delays).toEqual([1000, 2000, 4000])
})

test('a short deadline prevents another retry and a late successful response is refused', async () => {
  const f = fixture([new Error('connection reset')], 1000)
  await expect(f.call()).rejects.toThrow('wait budget')
  expect(f.calls()).toBe(1)
  let time = 0
  const api = createGitHubApi({ token: '', now: () => time, fetch: (async () => {
    time = 1001
    return Response.json({ ok: true })
  }) as unknown as typeof fetch })
  await expect(api('repos/owner/repo', {}, 1000)).rejects.toThrow('wait budget')
})

test('an ambiguously accepted dispatch is left to reconciliation instead of blindly repeated', async () => {
  let calls = 0
  const api = createGitHubApi({ token: '', fetch: (async () => {
    calls++
    throw new Error('response lost after dispatch')
  }) as unknown as typeof fetch })
  await expect(api('repos/owner/repo/actions/workflows/publish.yml/dispatches', { method: 'POST' })).rejects.toThrow('network request failed')
  expect(calls).toBe(1)
})
