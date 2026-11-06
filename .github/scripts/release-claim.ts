import { appendFile } from 'node:fs/promises'

export async function releaseClaim(mode: string, options: {
  token: string, owner: string, claimId?: string, required: boolean,
  request?: typeof fetch, output: (values: Record<string, string>) => Promise<void>,
}): Promise<void> {
  try {
    if (!options.token) throw new Error('PANTRY_TOKEN is required to consume release notifications')
    const ack = mode === 'ack'
    if (ack && !/^[a-f0-9-]{36}$/.test(options.claimId ?? '')) throw new Error('Expected release claim ID')
    const response = await (options.request ?? fetch)(`https://registry.pantry.dev/api/rebuild-queue/${ack ? 'ack' : 'lease'}`, {
      method: 'POST', headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(ack ? { claimId: options.claimId } : { owner: options.owner }), signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`Release ${mode} HTTP ${response.status}`)
    const body = await response.json() as any
    if (ack) {
      if (typeof body.acknowledged !== 'boolean') throw new Error('Invalid release acknowledgement')
      return
    }
    if (!Array.isArray(body.claimed) || body.claimed.some((domain: unknown) => typeof domain !== 'string' || !/^[a-zA-Z0-9._/-]{1,128}$/.test(domain))
      || (body.claimed.length && (typeof body.claimId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.claimId))))
      throw new Error('Registry did not return a recoverable release lease')
    await options.output({ domains: body.claimed.join(' '), claim_id: body.claimId ?? '' })
  }
  catch (error) {
    if (options.required || mode === 'ack') throw error
    console.warn(`::warning::Release queue unavailable; continuing the full sweep: ${String(error)}`)
    await options.output({ domains: '', claim_id: '' })
  }
}

if (import.meta.main) {
  await releaseClaim(process.argv[2] ?? 'claim', {
    token: process.env.PANTRY_TOKEN ?? '', owner: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    claimId: process.env.CLAIM_ID, required: process.env.CLAIMED_ONLY === 'true',
    output: async values => {
      await appendFile(process.env.GITHUB_OUTPUT!, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''))
    },
  })
}
