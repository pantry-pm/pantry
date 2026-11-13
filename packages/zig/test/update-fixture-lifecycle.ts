import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmdirSync, type Stats, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

type Identity = Stats
type Claim = { path: string, kind: 'absent' | 'empty-environment' | 'archive', SHA256?: string }
type Entry = { path: string, identity: Identity }
interface SecondaryFailure { stage: string, error: unknown }
export interface PrimaryFixtureFailure { error: unknown }

export function fixtureError(error: unknown): string {
  try { return String(error) }
  catch { return 'Unprintable fixture error' }
}

function info(path: string): Identity | null {
  try { return lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function within(parent: string, path: string): boolean {
  const suffix = relative(parent, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}
function unchanged(entry: Entry): void {
  const current = info(entry.path)
  if (!current || current.dev !== entry.identity.dev || current.ino !== entry.identity.ino || current.mode !== entry.identity.mode)
    throw new Error(`Owned fixture path identity changed: ${entry.path}`)
}

// Test infrastructure only. No native installer/routing/configuration decisions
// live here, and no shared cache or environment aggregate is read or modified.
export class UpdateFixtureLifecycle {
  private readonly rootEntry: Entry
  private readonly claims: Claim[] = []

  constructor(readonly root: string, readonly retainDiagnostics: boolean = false) {
    const identity = lstatSync(root)
    if (!identity.isDirectory() || identity.isSymbolicLink() || (identity.mode & 0o077) !== 0)
      throw new Error('Fixture root must be the newly created private mkdtemp directory')
    this.rootEntry = { path: root, identity }
  }

  // Call only at the original absence prerequisite, before any native command.
  claimAbsent(path: string, kind: Claim['kind'], SHA256?: string): void {
    if (info(path)) throw new Error(`Refusing pre-existing fixture cleanup target: ${path}`)
    if (kind === 'archive' && !/^[a-f0-9]{64}$/.test(SHA256 ?? '')) throw new Error('An owned archive requires its fixed expected SHA256')
    if (this.claims.some(claim => claim.path === path)) throw new Error(`Duplicate fixture cleanup target: ${path}`)
    this.claims.push({ path, kind, SHA256 })
  }

  private cleanup(): { removedRoot: string, removedExternalPaths: string[] } {
    unchanged(this.rootEntry)
    const external: Entry[] = []
    // Preflight every target before deleting anything. Unexpected state stays.
    for (const claim of this.claims) {
      const current = info(claim.path)
      if (!current) continue
      if (claim.kind === 'absent') throw new Error(`Unexpected fixture state must remain for inspection: ${claim.path}`)
      if (claim.kind === 'archive') {
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
          || createHash('sha256').update(readFileSync(claim.path)).digest('hex') !== claim.SHA256)
          throw new Error(`Refusing changed or foreign archive identity: ${claim.path}`)
        if (!within(this.root, claim.path)) external.push({ path: claim.path, identity: current })
      }
      else {
        if (!current.isDirectory() || current.isSymbolicLink() || readdirSync(claim.path).join('\n') !== 'bin')
          throw new Error(`Refusing unexpected native environment: ${claim.path}`)
        const bin = resolve(claim.path, 'bin'), binInfo = lstatSync(bin)
        if (!binInfo.isDirectory() || binInfo.isSymbolicLink() || readdirSync(bin).length !== 0)
          throw new Error(`Refusing nonempty or redirected native environment bin: ${bin}`)
        if (!within(this.root, claim.path)) external.push({ path: bin, identity: binInfo }, { path: claim.path, identity: current })
      }
    }
    const tree: Entry[] = []
    const visit = (path: string): void => {
      const identity = lstatSync(path)
      if (identity.dev !== this.rootEntry.identity.dev) throw new Error(`Refusing mounted fixture subtree: ${path}`)
      if (identity.isDirectory() && !identity.isSymbolicLink()) {
        for (const name of readdirSync(path)) visit(resolve(path, name))
      }
      else if (identity.isSymbolicLink()) {
        const target = resolve(dirname(path), readlinkSync(path))
        const ownedEnvironment = this.claims.some(claim => claim.kind === 'empty-environment' && within(claim.path, target))
        if (!within(this.root, target) && !ownedEnvironment) throw new Error(`Refusing escaping fixture link: ${path}`)
      }
      else if (!identity.isFile() || identity.nlink !== 1) {
        throw new Error(`Refusing special or hard-linked fixture state: ${path}`)
      }
      tree.push({ path, identity })
    }
    visit(this.root)
    for (const entry of [...external, ...tree]) {
      unchanged(entry)
      if (entry.identity.isDirectory() && !entry.identity.isSymbolicLink()) rmdirSync(entry.path)
      else unlinkSync(entry.path)
      if (info(entry.path)) throw new Error(`Owned fixture cleanup left a path: ${entry.path}`)
    }
    // Never remove shared parents, even if they happen to be empty.
    return { removedRoot: this.root, removedExternalPaths: external.map(entry => entry.path) }
  }

  async finish(options: {
    report: Record<string, unknown>
    primaryFailure?: PrimaryFixtureFailure
    stop: () => void | Promise<void>
    capture: () => void | Promise<void>
    save: () => void | Promise<void>
    trace: (retained: boolean) => void | Promise<void>
  }): Promise<void> {
    const { report, primaryFailure } = options
    const failures: SecondaryFailure[] = []
    const attempt = async (stage: string, operation: () => void | Promise<void>): Promise<void> => {
      try { await operation() }
      catch (error) { failures.push({ stage, error }) }
    }
    const semanticsPassed = report.passed === true
    const lifecycle = {
      semanticsPassed, retentionRequested: this.retainDiagnostics, retained: true,
      cleanup: 'not attempted', primaryError: primaryFailure ? fixtureError(primaryFailure.error) : null,
      secondaryErrors: [] as { stage: string, message: string }[],
      removed: null as { removedRoot: string, removedExternalPaths: string[] } | null,
    }
    report.fixtureLifecycle = lifecycle
    if (!semanticsPassed && !primaryFailure) failures.push({ stage: 'fixture outcome', error: new Error('Fixture finished without a passing contract or primary error') })
    await attempt('stop owned server', options.stop)
    await attempt('capture final observations', options.capture)
    lifecycle.secondaryErrors = failures.map(failure => ({ stage: failure.stage, message: fixtureError(failure.error) }))
    report.retained = true
    await attempt('save final observations', options.save)
    lifecycle.secondaryErrors = failures.map(failure => ({ stage: failure.stage, message: fixtureError(failure.error) }))
    if (!primaryFailure && failures.length) report.passed = false
    // Persist the bounded semantic observations in test output before deleting
    // their private files. If this fails, keep the evidence and fail the case.
    await attempt('persist observation in test output', () => console.info(`PANTRY_UPDATE_FIXTURE_OBSERVATION:${JSON.stringify(report)}`))
    if (semanticsPassed && !primaryFailure && failures.length === 0 && !this.retainDiagnostics) {
      await attempt('clean invocation-owned paths', () => {
        lifecycle.removed = this.cleanup()
        lifecycle.retained = false; report.retained = false; lifecycle.cleanup = 'verified absent'
      })
    }
    else lifecycle.cleanup = this.retainDiagnostics ? 'explicit diagnostic retention' : 'retained after fixture failure'
    if (lifecycle.retained) {
      lifecycle.secondaryErrors = failures.map(failure => ({ stage: failure.stage, message: fixtureError(failure.error) }))
      await attempt('save retained lifecycle outcome', options.save)
    }
    if (failures.length) {
      if (!primaryFailure) report.passed = false
      lifecycle.cleanup = 'retained after observation or cleanup failure'
      lifecycle.secondaryErrors = failures.map(failure => ({ stage: failure.stage, message: fixtureError(failure.error) }))
      // One best-effort report update; no failed report write can hide a primary.
      if (lifecycle.retained) await attempt('save secondary failure observations', options.save)
    }
    lifecycle.secondaryErrors = failures.map(failure => ({ stage: failure.stage, message: fixtureError(failure.error) }))
    // The small report survives default cleanup in CI output, not another leaked
    // directory. First diagnostic campaigns may explicitly retain their files.
    await attempt('emit fixture report', () => console.info(`PANTRY_UPDATE_FIXTURE_REPORT:${JSON.stringify(report)}`))
    await attempt('emit fixture trace', () => options.trace(lifecycle.retained))
    lifecycle.secondaryErrors = failures.map(failure => ({ stage: failure.stage, message: fixtureError(failure.error) }))
    if (!primaryFailure && failures.length) report.passed = false
    if (primaryFailure) {
      try { console.error(`PANTRY_UPDATE_FIXTURE_PRIMARY:${lifecycle.primaryError}`) }
      catch { /* Keep the original pending throw even if every report sink fails. */ }
    }
    for (const failure of failures) {
      try { console.error(`PANTRY_UPDATE_FIXTURE_SECONDARY:${failure.stage}: ${fixtureError(failure.error)}`) }
      catch { /* A broken output stream cannot replace the original failure. */ }
    }
    if (!primaryFailure && failures.length) throw new AggregateError(failures.map(failure => failure.error), 'Fixture observation or owned cleanup failed')
  }
}
