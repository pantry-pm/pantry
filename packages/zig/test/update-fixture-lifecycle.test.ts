import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateFixtureLifecycle } from './update-fixture-lifecycle'

const parents: string[] = []
function fixture(retainDiagnostics = false) {
  const parent = mkdtempSync(join(tmpdir(), 'pantry-fixture-lifecycle-unit-'))
  parents.push(parent)
  const root = mkdtempSync(join(parent, 'private-root-'))
  return { parent, root, lifecycle: new UpdateFixtureLifecycle(root, retainDiagnostics) }
}
afterEach(() => {
  // These parents contain only the filesystem test's own synthetic state.
  for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true })
})

describe.skipIf(!['darwin', 'linux'].includes(process.platform))('owned update fixture lifecycle', () => {
  it('removes only the private tree and claimed exact external identities', async () => {
    const { parent, root, lifecycle } = fixture()
    const environment = join(parent, 'native-env'), archive = join(parent, 'archive-cache')
    const bytes = 'independently fixed archive bytes'
    lifecycle.claimAbsent(environment, 'empty-environment')
    lifecycle.claimAbsent(archive, 'archive', createHash('sha256').update(bytes).digest('hex'))
    mkdirSync(join(environment, 'bin'), { recursive: true }); writeFileSync(archive, bytes)
    const foreign = join(parent, 'unrelated-cache-record'); writeFileSync(foreign, 'preserve')
    writeFileSync(join(root, 'payload'), 'owned')
    symlinkSync('payload', join(root, 'owned-alias'))
    const report: Record<string, unknown> = { passed: true }
    let captured = false, traced: boolean | undefined
    await lifecycle.finish({ report, stop: () => {}, capture: () => { captured = true },
      save: () => writeFileSync(join(root, 'report.json'), JSON.stringify(report)), trace: retained => { traced = retained } })
    expect(captured).toBe(true); expect(traced).toBe(false)
    expect([existsSync(root), existsSync(environment), existsSync(archive)]).toEqual([false, false, false])
    expect(readFileSync(foreign, 'utf8')).toBe('preserve')
    expect(existsSync(parent)).toBe(true)
  })

  it('retains an explicitly requested diagnostic after successful observation', async () => {
    const { root, lifecycle } = fixture(true)
    const report: Record<string, unknown> = { passed: true }
    await lifecycle.finish({ report, stop: () => {}, capture: () => {},
      save: () => writeFileSync(join(root, 'report.json'), JSON.stringify(report)), trace: () => {} })
    expect(existsSync(root)).toBe(true)
    expect(report.passed).toBe(true); expect(report.retained).toBe(true)
  })

  it('awaits owned server shutdown before observing or deleting fixture state', async () => {
    const { root, lifecycle } = fixture()
    let finishStop: () => void = () => {}
    const stopped = new Promise<void>((resolve) => { finishStop = resolve })
    let captured = false
    const pending = lifecycle.finish({ report: { passed: true }, stop: () => stopped,
      capture: () => { captured = true }, save: () => {}, trace: () => {} })
    expect(captured).toBe(false); expect(existsSync(root)).toBe(true)
    finishStop(); await pending
    expect(captured).toBe(true); expect(existsSync(root)).toBe(false)
  })

  it('preflights changed archive bytes before deleting any owned target', async () => {
    const { parent, root, lifecycle } = fixture()
    const archive = join(parent, 'archive'), environment = join(parent, 'env')
    lifecycle.claimAbsent(environment, 'empty-environment')
    lifecycle.claimAbsent(archive, 'archive', createHash('sha256').update('expected').digest('hex'))
    mkdirSync(join(environment, 'bin'), { recursive: true }); writeFileSync(archive, 'unexpected')
    const report: Record<string, unknown> = { passed: true }
    await expect(lifecycle.finish({ report, stop: () => {}, capture: () => {},
      save: () => writeFileSync(join(root, 'report.json'), JSON.stringify(report)), trace: () => {} })).rejects.toThrow(AggregateError)
    expect([existsSync(root), existsSync(environment)]).toEqual([true, true])
    expect(readFileSync(archive, 'utf8')).toBe('unexpected')
    expect(report.passed).toBe(false)
  })

  it('preserves unexpected native environment contents and the private evidence', async () => {
    const { parent, root, lifecycle } = fixture()
    const environment = join(parent, 'env')
    lifecycle.claimAbsent(environment, 'empty-environment')
    mkdirSync(join(environment, 'bin'), { recursive: true })
    writeFileSync(join(environment, 'bin', 'foreign'), 'preserve')
    await expect(lifecycle.finish({ report: { passed: true }, stop: () => {}, capture: () => {},
      save: () => {}, trace: () => {} })).rejects.toThrow(AggregateError)
    expect(existsSync(root)).toBe(true)
    expect(readFileSync(join(environment, 'bin', 'foreign'), 'utf8')).toBe('preserve')
  })

  it('keeps the exact primary error when final capture and report saving also fail', async () => {
    const { root, lifecycle } = fixture()
    const primary = new Error('original public-command assertion')
    const report: Record<string, unknown> = { passed: false }
    let caught: unknown
    writeFileSync(join(root, 'malformed-observation.json'), '{')
    try {
      try { throw primary }
      finally {
        await lifecycle.finish({ report, primaryFailure: { error: primary }, stop: () => {},
          capture: () => JSON.parse(readFileSync(join(root, 'malformed-observation.json'), 'utf8')),
          save: () => writeFileSync(join(root, 'absent-parent', 'report.json'), JSON.stringify(report)), trace: () => {} })
      }
    }
    catch (error) { caught = error }
    expect(caught).toBe(primary)
    expect(existsSync(root)).toBe(true)
    const result = report.fixtureLifecycle as { primaryError: string, secondaryErrors: { stage: string }[] }
    expect(result.primaryError).toContain('original public-command assertion')
    expect(result.secondaryErrors.map(error => error.stage)).toContain('capture final observations')
    expect(result.secondaryErrors.map(error => error.stage)).toContain('save final observations')
  })

  it('fails a semantically successful case when required reporting fails', async () => {
    const { root, lifecycle } = fixture()
    const report: Record<string, unknown> = { passed: true }
    await expect(lifecycle.finish({ report, stop: () => {}, capture: () => {},
      save: () => writeFileSync(join(root, 'absent-parent', 'report.json'), 'required'), trace: () => {} })).rejects.toThrow(AggregateError)
    expect(existsSync(root)).toBe(true); expect(report.passed).toBe(false)
  })

  it('does not follow a private-tree link into unrelated state', async () => {
    const { parent, root, lifecycle } = fixture()
    const foreign = join(parent, 'foreign'); writeFileSync(foreign, 'preserve')
    symlinkSync(foreign, join(root, 'escape'))
    await expect(lifecycle.finish({ report: { passed: true }, stop: () => {}, capture: () => {}, save: () => {}, trace: () => {} })).rejects.toThrow(AggregateError)
    expect(existsSync(root)).toBe(true); expect(readFileSync(foreign, 'utf8')).toBe('preserve')
  })

  it('refuses hard-linked private files instead of assuming exclusive ownership', async () => {
    const { parent, root, lifecycle } = fixture()
    const foreign = join(parent, 'foreign'); writeFileSync(foreign, 'preserve')
    linkSync(foreign, join(root, 'hard-link'))
    await expect(lifecycle.finish({ report: { passed: true }, stop: () => {}, capture: () => {}, save: () => {}, trace: () => {} })).rejects.toThrow(AggregateError)
    expect(existsSync(root)).toBe(true); expect(readFileSync(foreign, 'utf8')).toBe('preserve')
  })
})
