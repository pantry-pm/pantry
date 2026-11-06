import { expect, test } from 'bun:test'
import { releaseClaim } from '../../../.github/scripts/release-claim'

const id = 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12)
function fixture(body: unknown, status = 200) {
  const output: Record<string, string>[] = []
  const requests: Array<{ url: string, body: any }> = []
  return { output, requests, options: { token: 'fixture-only', owner: '123-1', required: true,
    request: (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) })
      return Response.json(body, { status })
    }) as typeof fetch,
    output: async (value: Record<string, string>) => { output.push(value) },
  } }
}

test('only consumes recoverable leases, publishes validated outputs, and ACKs the exact ID', async () => {
  const f = fixture({ claimed: ['curl.se'], claimId: id })
  await releaseClaim('claim', f.options)
  expect(f.requests[0]!.url).toEndWith('/lease')
  expect(f.requests[0]!.body).toEqual({ owner: '123-1' })
  expect(f.output).toEqual([{ domains: 'curl.se', claim_id: id }])
  const ack = fixture({ acknowledged: true })
  await releaseClaim('ack', { ...ack.options, claimId: id })
  expect(ack.requests[0]!.body).toEqual({ claimId: id })
})

for (const body of [{ claimed: ['curl.se'] }, { claimed: ['bad domain'], claimId: id }, {}, { claimed: 'curl.se' }]) {
  test(`rejects malformed or destructive legacy claims: ${JSON.stringify(body)}`, async () => {
    const f = fixture(body)
    await expect(releaseClaim('claim', f.options)).rejects.toThrow('recoverable')
    expect(f.output).toEqual([])
  })
}

test('a claimed-only run fails loudly on registry errors or missing credentials', async () => {
  const f = fixture({}, 403)
  await expect(releaseClaim('claim', f.options)).rejects.toThrow('HTTP 403')
  await expect(releaseClaim('claim', { ...f.options, token: '' })).rejects.toThrow('PANTRY_TOKEN')
  expect(f.output).toEqual([])
})

test('a full sweep continues without claiming when the new endpoint is not deployed yet', async () => {
  const f = fixture({}, 404)
  await releaseClaim('claim', { ...f.options, required: false })
  expect(f.output).toEqual([{ domains: '', claim_id: '' }])
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]!.url).toEndWith('/lease')
})

test('ACK failures always fail the step, leaving the lease recoverable', async () => {
  const f = fixture({}, 503)
  await expect(releaseClaim('ack', { ...f.options, claimId: id, required: false })).rejects.toThrow('HTTP 503')
})


test('a consumer that fails before leasing cannot recursively dispatch itself', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(new URL('../../../.github/workflows/drain-release-queue.yml', import.meta.url)).text()) as any
  expect(workflow.jobs.drain.if).toContain("github.event.workflow_run.name != 'Update Packages'")
  expect(workflow.jobs.drain.if).toContain("github.event.workflow_run.conclusion == 'success'")
})
