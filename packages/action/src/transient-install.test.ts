import { describe, expect, it } from 'bun:test'
import { isTransientPantryFailure, runRetryingTransientInstall } from './transient-install'

const TIMED_OUT = `
error: 1 package failed to install:
  ffmpeg.org@9.0.2: timed out; failed again after one retry [transient: network, timeout or registry outage; a rerun may pass]
::error title=pantry install failed::ffmpeg.org@9.0.2: timed out; failed again after one retry (transient)
`

function fakeInstall(results: Array<{ code: number, output?: string }>) {
  const calls: number[] = []
  const install = async (listeners: { stdout?: (data: Buffer) => void }): Promise<number> => {
    const result = results[calls.length] ?? results.at(-1)!
    calls.push(result.code)
    if (result.output) listeners.stdout?.(Buffer.from(result.output))
    return result.code
  }
  return { install, calls }
}

describe('isTransientPantryFailure', () => {
  it('recognises the markers Pantry prints for a timed-out download', () => {
    expect(isTransientPantryFailure(TIMED_OUT)).toBe(true)
  })

  it('does not treat a resolution failure as transient', () => {
    expect(isTransientPantryFailure('error: no version of ffmpeg.org matches 99.0.0')).toBe(false)
  })
})

describe('runRetryingTransientInstall', () => {
  it('reruns an install that timed out and returns the passing exit code', async () => {
    const { install, calls } = fakeInstall([{ code: 1, output: TIMED_OUT }, { code: 0 }])
    const sleeps: number[] = []
    const warnings: string[] = []
    const code = await runRetryingTransientInstall('pantry install ffmpeg.org@9.0.2', install, {
      sleep: async ms => void sleeps.push(ms),
      onRetry: message => warnings.push(message),
    })
    expect(code).toBe(0)
    expect(calls).toEqual([1, 0])
    expect(sleeps).toEqual([30_000])
    expect(warnings[0]).toContain('attempt 1 of 3')
  })

  it('returns a non-transient failure without rerunning it', async () => {
    const { install, calls } = fakeInstall([{ code: 1, output: 'error: no version matches' }])
    const code = await runRetryingTransientInstall('install', install, { sleep: async () => {} })
    expect(code).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('stops after the last attempt and backs off between attempts', async () => {
    const { install, calls } = fakeInstall([{ code: 1, output: TIMED_OUT }])
    const sleeps: number[] = []
    const code = await runRetryingTransientInstall('install', install, { sleep: async ms => void sleeps.push(ms) })
    expect(code).toBe(1)
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([30_000, 60_000])
  })

  it('waits for a registry cooldown within the action retry budget', async () => {
    const output = '::error title=pantry install failed::postgresql.org@17.10: registry answered HTTP 429 (Retry-After 45s) (transient)'
    const { install, calls } = fakeInstall([{ code: 1, output }, { code: 0 }])
    const sleeps: number[] = []
    expect(await runRetryingTransientInstall('install', install, { sleep: async ms => void sleeps.push(ms) })).toBe(0)
    expect(calls).toEqual([1, 0])
    expect(sleeps).toEqual([45_000])
  })

  it.each([
    ['::error title=pantry install failed::postgresql.org@17.10: registry answered HTTP 429 (Retry-After 1861s) (transient)', 'Retry-After 1861s'],
    ['  Registry GET HTTP 429 from https://registry.pantry.dev; Retry-After exceeds request budget\n::error title=pantry install failed::postgresql.org@17.10: registry answered HTTP 429 (transient)', 'Retry-After exceeds the download budget'],
  ])('stops on a registry cooldown outside the action retry budget', async (output, hint) => {
    const { install, calls } = fakeInstall([{ code: 1, output }])
    const sleeps: number[] = []
    const warnings: string[] = []
    expect(await runRetryingTransientInstall('install', install, {
      sleep: async ms => void sleeps.push(ms),
      onRetry: message => warnings.push(message),
    })).toBe(1)
    expect(calls).toEqual([1])
    expect(sleeps).toEqual([])
    expect(warnings[0]).toContain(hint)
  })

  it('reads output from each attempt on its own', async () => {
    const { install, calls } = fakeInstall([
      { code: 1, output: TIMED_OUT },
      { code: 1, output: 'error: checksum mismatch' },
      { code: 0 },
    ])
    const code = await runRetryingTransientInstall('install', install, { sleep: async () => {} })
    expect(code).toBe(1)
    expect(calls).toHaveLength(2)
  })
})
