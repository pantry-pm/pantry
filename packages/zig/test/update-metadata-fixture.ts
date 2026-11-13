import { expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { fixtureError, type PrimaryFixtureFailure, UpdateFixtureLifecycle } from './update-fixture-lifecycle'

const hash = (bytes: Uint8Array | string, algorithm = 'sha256'): string => createHash(algorithm).update(bytes).digest('hex')
function present(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function state(path: string): Record<string, unknown> {
  if (!present(path)) return { present: false }
  const info = lstatSync(path)
  return {
    present: true, file: info.isFile(), directory: info.isDirectory(), symlink: info.isSymbolicLink(),
    bytes: info.size, inode: info.ino, mtimeMs: info.mtimeMs,
    SHA256: info.isFile() ? hash(readFileSync(path)) : null,
  }
}

// Both callers drive the real public updater. Only the external registry
// response differs; no resolver, installer, metadata cache or writer is mocked.
export async function verifyMetadataUpdate(mode: 'unavailable' | 'empty' | 'malformed' | 'empty-body' | 'wrong-schema'): Promise<void> {
  const binary = process.env.PANTRY_SOURCE_CLI
  if (!binary) throw new Error('PANTRY_SOURCE_CLI must name the qualified source executable')
  const root = realpathSync(mkdtempSync(join(tmpdir(), `pantry-update-metadata-${mode}-`)))
  const lifecycle = new UpdateFixtureLifecycle(root, process.env.PANTRY_UPDATE_RETAIN_DIAGNOSTICS === '1')
  const project = join(root, `${basename(root)} project with spaces`)
  const tools = join(root, 'tools')
  mkdirSync(project); mkdirSync(tools)
  const domain = `update-${basename(root).toLowerCase()}.invalid`
  const data = process.platform === 'darwin' ? join(homedir(), '.local/share/pantry') : join(root, 'data/pantry')
  const cache = process.platform === 'darwin' ? join(homedir(), '.cache/pantry') : join(root, 'cache/pantry')
  const manifest = join(project, 'pantry.json')
  const policy = join(project, 'pantry.toml')
  const projectDigest = createHash('md5').update(project).digest()
  const environment = join(data, 'envs', `${basename(project)}_${projectDigest.readUInt32LE().toString(16).padStart(8, '0')}-d${hash(manifest, 'md5').slice(0, 8)}`)
  const payload = join(project, 'pantry', domain)
  const lock = join(project, 'pantry.lock')
  const globalPackage = join(data, 'global/packages', domain)
  const archiveCache = join(cache, 'packages', hash(`${domain}@2.0.0`, 'md5'))
  const partials = join(cache, 'native-partials-v1')
  const observations = join(root, 'hook-observations.jsonl')
  const hookSource = join(root, 'hook.ts')
  const hook = join(tools, 'pantry-owned-metadata-hook')
  const hookCommand = `'${hook.replaceAll("'", "'\\''")}'`
  const status = mode === 'unavailable' ? 500 : 200
  const requests: { method: string, path: string, kind: string, status: number }[] = []
  const report: Record<string, unknown> = {
    scope: 'One real public update with fixed external metadata outcome and no seeded installation',
    mode, root, project, domain, environment, sourceBinary: realpathSync(binary), sourceBinarySHA256: hash(readFileSync(binary)),
    retention: 'Passing maintained cases remove only proved-owned paths; explicit diagnostic retention or any failure retains available state. No shared aggregate edit or user tool update.',
    credentialScope: 'Minimal child environment and public fixture token; no parent credentials, headers, request bodies or foreign cache records captured.',
    phase: 'Preparing real unused lifecycle executable and fixed metadata response',
  }
  const save = (): void => writeFileSync(join(root, 'metadata-result.json'), `${JSON.stringify(report, null, 2)}\n`)
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? homedir(), PATH: `${tools}${delimiter}/usr/bin${delimiter}/bin`, TMPDIR: root,
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), PANTRY_ENV_DEPS: '0',
    PANTRY_REGISTRY_TOKEN: 'ptry_owned_update_result', CI: '1', NO_COLOR: '1',
  }
  let server: ReturnType<typeof Bun.serve> | undefined
  let primaryFailure: PrimaryFixtureFailure | undefined
  async function run(args: string[], cwd: string, extra: Record<string, string> = {}) {
    const child = Bun.spawn(args, { cwd, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { code, stdout, stderr }
  }
  const productState = () => ({
    manifest: state(manifest), policy: state(policy), payload: state(payload), lock: state(lock),
    globalPackage: state(globalPackage), archiveCache: state(archiveCache), environment: state(environment),
  })
  const capture = (): void => {
    report.requests = requests
    report.finalProductState = productState()
    report.hookObservations = present(observations) ? readFileSync(observations, 'utf8') : null
  }
  try {
    expect(present(environment), 'Refusing a pre-existing owned native environment').toBe(false)
    lifecycle.claimAbsent(environment, 'absent')
    expect(present(globalPackage), 'Refusing a pre-existing global fixture package').toBe(false)
    lifecycle.claimAbsent(globalPackage, 'absent')
    expect(present(archiveCache), 'Refusing a pre-existing owned archive identity').toBe(false)
    lifecycle.claimAbsent(archiveCache, 'absent')
    expect(present(observations)).toBe(false)
    expect(present(partials) ? readdirSync(partials).filter(name => name.endsWith('.partial')) : [], 'Refusing foreign partial state').toEqual([])
    writeFileSync(hookSource, String.raw`import { appendFileSync } from 'node:fs'
appendFileSync(process.env.PANTRY_METADATA_OBSERVATIONS!, JSON.stringify({ executable: process.execPath, argv: process.argv.slice(2), cwd: process.cwd() }) + '\n')
console.log('Owned metadata hook executed unexpectedly')
process.exit(0)
`)
    const built = await run([process.execPath, 'build', hookSource, '--compile', '--outfile', hook], root)
    report.hookBuild = built
    expect(built.code, built.stdout + built.stderr).toBe(0)
    expect(present(observations), 'Compiling the executable must not invoke it').toBe(false)
    const hookBefore = state(hook), hookSourceBefore = state(hookSource)
    report.hook = { executable: realpathSync(hook), before: hookBefore, sourceBefore: hookSourceBefore }
    writeFileSync(manifest, JSON.stringify({
      name: `owned-update-metadata-${mode}`, global: false,
      dependencies: { [domain]: { version: '2.0.0', global: false } },
      scripts: { preinstall: hookCommand },
    }, null, 2))
    writeFileSync(policy, '[install]\npeer = false\nproduction = false\nmodulesDir = "pantry"\n')
    const before = productState()
    report.originalDeclaration = JSON.parse(readFileSync(manifest, 'utf8'))
    report.initialProductState = before
    expect(before.payload).toEqual({ present: false })
    expect(before.lock).toEqual({ present: false })
    server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (request.method === 'GET' && path === `/binaries/${domain}/metadata.json`) {
          requests.push({ method: request.method, path, kind: 'metadata', status })
          if (mode === 'unavailable') return new Response('Owned registry metadata unavailable', { status })
          if (mode === 'malformed') return new Response('{', { headers: { 'content-type': 'application/json' } })
          if (mode === 'empty-body') return new Response('')
          if (mode === 'wrong-schema') return Response.json({ versions: [] })
          return Response.json({ versions: {} })
        }
        requests.push({ method: request.method, path, kind: 'unexpected', status: 500 })
        return new Response('Unexpected fixture route', { status: 500 })
      },
    })
    report.phase = 'Running one real update against the fixed registry response'; save()
    const result = await run([binary, 'update', '--latest'], project, {
      PANTRY_REGISTRY_URL: server.url.origin, PANTRY_METADATA_OBSERVATIONS: observations,
    })
    report.result = result
    writeFileSync(join(root, 'stdout.log'), result.stdout)
    writeFileSync(join(root, 'stderr.log'), result.stderr)
    capture(); save()
    const context = JSON.stringify({ result, requests, root })
    expect([0, 1], context).toContain(result.code)
    expect(requests.length, 'The actual native updater must reach the owned metadata endpoint').toBeGreaterThan(0)
    expect(requests.every(request => request.method === 'GET' && request.path === `/binaries/${domain}/metadata.json` && request.kind === 'metadata' && request.status === status), context).toBe(true)
    expect(productState(), 'Metadata-only outcomes must preserve desired bytes and all payload/lock/cache/global/environment identities').toEqual(before)
    expect(present(observations), 'No installation lifecycle may run').toBe(false)
    expect(state(hook), 'Lifecycle executable identity must remain exact').toEqual(hookBefore)
    expect(state(hookSource), 'Lifecycle source identity must remain exact').toEqual(hookSourceBefore)
    expect(JSON.parse(readFileSync(manifest, 'utf8')).dependencies[domain], context).toEqual({ version: '2.0.0', global: false })
    expect(present(partials) ? readdirSync(partials).filter(name => name.endsWith('.partial')) : [], 'No native partial may be created').toEqual([])
    report.nativeMetadataPrerequisitesPassed = true
    report.phase = 'Actual metadata response and unchanged product state confirmed; asserting public outcome'; save()
    expect(result.code, context).toBe(mode === 'empty' ? 0 : 1)
    if (mode !== 'empty')
      expect(result.stdout + result.stderr, context).not.toMatch(/All packages are already up to date|Updated \d+ packages?/)
    report.phase = mode === 'empty' ? 'Valid metadata with no available candidate remained idle' : 'Metadata failure returned nonzero without product changes'
    report.passed = true
  }
  catch (error) {
    primaryFailure = { error }
    report.passed = false
    report.error = fixtureError(error)
    report.classification = report.nativeMetadataPrerequisitesPassed
      ? 'Actual fixed metadata response completed without product changes; public exit contract failed'
      : 'Hook/setup/native-request/product-state prerequisite failure; not accepted as metadata exit semantic evidence'
    throw error
  }
  finally {
    await lifecycle.finish({
      report, primaryFailure, stop: () => server?.stop(true), capture, save,
      trace: retained => console.info(`PANTRY_UPDATE_METADATA_TRACE:${JSON.stringify({ root, receipt: retained ? join(root, 'metadata-result.json') : null, mode, phase: report.phase, passed: report.passed, classification: report.classification, retained })}`),
    })
  }
}
