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

// Real command and installer in both cases. Only a public input lock is invalid
// in the thrown-error control; successful installation uses verified archives.
export async function verifyUpdateInstallCompletion(mode: 'success' | 'invalid-lock'): Promise<void> {
  const binary = process.env.PANTRY_SOURCE_CLI
  if (!binary) throw new Error('PANTRY_SOURCE_CLI must name the qualified source executable')
  const root = realpathSync(mkdtempSync(join(tmpdir(), `pantry-update-completion-${mode}-`)))
  const lifecycle = new UpdateFixtureLifecycle(root, process.env.PANTRY_UPDATE_RETAIN_DIAGNOSTICS === '1')
  const project = join(root, `${basename(root)} project with spaces`), tools = join(root, 'tools')
  mkdirSync(project); mkdirSync(tools)
  const domain = `update-${basename(root).toLowerCase()}.invalid`
  const platform = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x86-64'}`
  const data = process.platform === 'darwin' ? join(homedir(), '.local/share/pantry') : join(root, 'data/pantry')
  const cache = process.platform === 'darwin' ? join(homedir(), '.cache/pantry') : join(root, 'cache/pantry')
  const manifest = join(project, 'pantry.json'), policy = join(project, 'pantry.toml'), lock = join(project, 'pantry.lock')
  const digest = createHash('md5').update(project).digest()
  const environment = join(data, 'envs', `${basename(project)}_${digest.readUInt32LE().toString(16).padStart(8, '0')}-d${hash(manifest, 'md5').slice(0, 8)}`)
  const globalPackage = join(data, 'global/packages', domain), systemPackage = join('/usr/local/packages', domain)
  const payload = join(project, 'pantry', domain), partials = join(cache, 'native-partials-v1')
  const hook = join(tools, 'pantry-owned-completion-hook'), hookSource = join(root, 'hook.ts'), observations = join(root, 'hook-observations.jsonl')
  const hookCommand = `'${hook.replaceAll("'", "'\\''")}'`
  const invalidLock = '{"version":"1.0","packages":[]}'
  const requests: { method: string, path: string, kind: string }[] = [], unexpected: { method: string, path: string }[] = []
  const telemetry: { method: string, path: string, responseStatus: number }[] = []
  const archives = new Map<string, { version: string, bytes: Uint8Array, sha256: string, cachePath: string, partialPath: string }>()
  const report: Record<string, unknown> = {
    mode, root, project, domain, environment, globalPackage, systemPackage, payload, lock,
    sourceBinary: realpathSync(binary), sourceBinarySHA256: hash(readFileSync(binary)),
    scope: 'One real public update and native installer, with valid fixed archives and either a genuine successful install or invalid public lock input',
    retention: 'Passing maintained cases remove only proved-owned root, empty native environment and matching archive files. Explicit diagnostics or failures retain available state; shared aggregates are untouched.',
    credentialScope: 'Minimal environment and public fixture token, unchanged HOME, no header/auth/body capture', phase: 'Preparing real hook and independent native archives',
  }
  const save = (): void => writeFileSync(join(root, 'completion-result.json'), `${JSON.stringify(report, null, 2)}\n`)
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? homedir(), PATH: `${tools}${delimiter}/usr/bin${delimiter}/bin`, TMPDIR: root,
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), PANTRY_ENV_DEPS: '0',
    PANTRY_REGISTRY_TOKEN: 'ptry_owned_update_result', PANTRY_COMPLETION_OBSERVATIONS: observations,
    COPYFILE_DISABLE: '1', CI: '1', NO_COLOR: '1',
  }
  async function run(argv: string[], cwd: string) {
    const child = Bun.spawn(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { argv, code, stdout, stderr }
  }
  const hooks = (): { executable: string, argv: string[], cwd: string }[] => present(observations)
    ? readFileSync(observations, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const capture = (): void => {
    report.requests = requests; report.unexpectedRequests = unexpected; report.telemetryRequests = telemetry; report.hookObservations = hooks()
    report.finalState = { manifest: state(manifest), policy: state(policy), lock: state(lock), payload: state(payload), environment: state(environment), globalPackage: state(globalPackage), systemPackage: state(systemPackage) }
    report.nativeCacheState = [...archives.values()].map(archive => ({ version: archive.version, cachePath: archive.cachePath, cache: state(archive.cachePath), partialPath: archive.partialPath, partial: state(archive.partialPath) }))
  }
  let server: ReturnType<typeof Bun.serve> | undefined
  let primaryFailure: PrimaryFixtureFailure | undefined
  try {
    for (const path of [environment, globalPackage, systemPackage, payload, lock, observations]) {
      expect(present(path), `Refusing pre-existing fixture target ${path}`).toBe(false)
    }
    lifecycle.claimAbsent(environment, 'empty-environment')
    lifecycle.claimAbsent(globalPackage, 'absent'); lifecycle.claimAbsent(systemPackage, 'absent')
    expect(present(partials) ? readdirSync(partials).filter(name => name.endsWith('.partial')) : [], 'Refusing foreign partial state').toEqual([])
    writeFileSync(hookSource, String.raw`import { appendFileSync } from 'node:fs'
appendFileSync(process.env.PANTRY_COMPLETION_OBSERVATIONS!, JSON.stringify({ executable: process.execPath, argv: process.argv.slice(2), cwd: process.cwd() }) + '\n')
console.info('Owned completion preinstall hook succeeds')
process.exit(0)
`)
    const built = await run([process.execPath, 'build', hookSource, '--compile', '--outfile', hook], root)
    report.hookBuild = built
    expect(built.code, built.stdout + built.stderr).toBe(0); expect(hooks()).toEqual([])
    const hookBefore = state(hook), sourceBefore = state(hookSource)
    const metadataVersions: Record<string, unknown> = {}, inventory: Record<string, unknown>[] = []
    for (const version of ['1.0.0', '2.0.0']) {
      const stage = join(root, 'stage', version), packageRoot = join(stage, domain, `v${version}`)
      mkdirSync(join(packageRoot, 'share'), { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: domain, version }))
      writeFileSync(join(packageRoot, 'share', 'update-completion.txt'), `Owned completion ${version}\n`)
      const archive = join(root, `${domain}-${version}.tar.gz`)
      const packed = await run(['/usr/bin/tar', '-czf', archive, '-C', stage, domain], root)
      expect(packed.code, packed.stdout + packed.stderr).toBe(0)
      const checked = join(root, 'checked', version); mkdirSync(checked, { recursive: true })
      const unpacked = await run(['/usr/bin/tar', '-xzf', archive, '-C', checked], root)
      expect(unpacked.code, unpacked.stdout + unpacked.stderr).toBe(0)
      expect(JSON.parse(readFileSync(join(checked, domain, `v${version}`, 'package.json'), 'utf8')).version).toBe(version)
      expect(readFileSync(join(checked, domain, `v${version}`, 'share', 'update-completion.txt'), 'utf8')).toBe(`Owned completion ${version}\n`)
      const bytes = readFileSync(archive), sha256 = hash(bytes)
      const path = `/binaries/${domain}/${version}/${platform}/${domain}-${version}.tar.gz`
      const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(bytes.byteLength))
      const key = hash(Buffer.concat([Buffer.from(`https://registry.pantry.dev${path}`), Buffer.from(sha256, 'hex'), size]))
      const cachePath = join(cache, 'packages', hash(`${domain}@${version}`, 'md5')), partialPath = join(partials, `${bytes.byteLength}-${key}.partial`)
      expect(present(cachePath)).toBe(false); expect(present(partialPath)).toBe(false)
      lifecycle.claimAbsent(cachePath, 'archive', sha256); lifecycle.claimAbsent(partialPath, 'absent')
      archives.set(path, { version, bytes, sha256, cachePath, partialPath })
      metadataVersions[version] = { platforms: { [platform]: { tarball: path.slice(1), sha256, size: bytes.byteLength } } }
      inventory.push({ version, archive, path, sha256, bytes: bytes.byteLength, cachePath, partialPath })
    }
    report.archives = inventory
    // This supported public section uses the actual canonical key already on
    // current main; these status controls do not depend on #335's writer repair.
    const declaration = { name: 'owned-update-completion', global: false, system: { [domain]: '1.0.0' }, scripts: { preinstall: hookCommand } }
    writeFileSync(manifest, JSON.stringify(declaration, null, 2))
    writeFileSync(policy, '[install]\npeer = false\nproduction = false\nmodulesDir = "pantry"\n')
    if (mode === 'invalid-lock') writeFileSync(lock, invalidLock)
    const policyBefore = state(policy), lockBefore = state(lock)
    report.initialState = { declaration, policy: policyBefore, lock: lockBefore, payload: state(payload), environment: state(environment) }
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const url = new URL(request.url), path = url.pathname
      // A fresh native install emits one best-effort detached batch POST. The
      // current registry rejects that array with this exact 400 response. Model
      // the actual public response, without reading headers or request bodies.
      if (mode === 'success' && request.method === 'POST' && path === '/analytics/events' && url.search === '') {
        telemetry.push({ method: request.method, path, responseStatus: 400 })
        return Response.json({ error: 'Missing or invalid packageName' }, { status: 400 })
      }
      if (request.method === 'GET' && path === `/binaries/${domain}/metadata.json`) {
        requests.push({ method: request.method, path, kind: 'metadata' }); return Response.json({ versions: metadataVersions })
      }
      const archive = archives.get(path)
      if (request.method === 'GET' && archive) {
        requests.push({ method: request.method, path, kind: 'archive' }); return new Response(archive.bytes, { headers: { 'content-type': 'application/gzip', 'content-length': String(archive.bytes.byteLength), etag: `"${archive.sha256}"` } })
      }
      const checksum = path.endsWith('.sha256') ? archives.get(path.slice(0, -7)) : undefined
      if (request.method === 'GET' && checksum) {
        requests.push({ method: request.method, path, kind: 'checksum' }); return new Response(`${checksum.sha256}\n`)
      }
      unexpected.push({ method: request.method, path }); return new Response('Unexpected fixture route', { status: 500 })
    } })
    env.PANTRY_REGISTRY_URL = server.url.origin
    report.phase = 'Running one public native update'; save()
    const result = await run([binary, 'update', '--latest'], project)
    report.result = result
    writeFileSync(join(root, 'stdout.log'), result.stdout); writeFileSync(join(root, 'stderr.log'), result.stderr)
    // Freeze observed routes before assertions. Delivery of detached telemetry
    // is optional; no additional product request is needed after native exit.
    await server.stop(false); server = undefined
    capture(); save()
    const output = result.stdout + result.stderr, context = JSON.stringify({ result, requests, hooks: hooks(), root })
    expect(unexpected, context).toEqual([])
    expect(requests.some(request => request.kind === 'metadata' && request.path === `/binaries/${domain}/metadata.json`), context).toBe(true)
    expect(JSON.parse(readFileSync(manifest, 'utf8')), context).toEqual({ ...declaration, system: { [domain]: '2.0.0' } })
    expect(state(policy)).toEqual(policyBefore); expect(state(hook)).toEqual(hookBefore); expect(state(hookSource)).toEqual(sourceBefore)
    expect(state(environment).directory, context).toBe(true)
    expect([present(globalPackage), present(systemPackage)], context).toEqual([false, false])
    expect([...archives.values()].map(archive => present(archive.partialPath)), context).toEqual([false, false])
    report.publicUpdatePrerequisitesPassed = true
    if (mode === 'success') {
      report.phase = 'Verifying actual successful installation and unchanged failure guard'; save()
      expect(result.code, context).toBe(0)
      expect(hooks(), context).toEqual([{ executable: realpathSync(hook), argv: [], cwd: project }])
      expect(readFileSync(join(payload, 'v2.0.0', 'share', 'update-completion.txt'), 'utf8')).toBe('Owned completion 2.0.0\n')
      expect(JSON.parse(readFileSync(join(payload, 'v2.0.0', 'package.json'), 'utf8')).version).toBe('2.0.0')
      const actualLock = JSON.parse(readFileSync(lock, 'utf8'))
      expect(Object.keys(actualLock.packages), context).toEqual([`${domain}@2.0.0`])
      expect(actualLock.packages[`${domain}@2.0.0`].version, context).toBe('2.0.0')
      expect(requests.filter(request => request.kind === 'archive').map(request => request.path), context).toEqual([`/binaries/${domain}/2.0.0/${platform}/${domain}-2.0.0.tar.gz`])
      report.actualSuccessfulInstallPrerequisitesPassed = true; save()
      expect(output, context).toContain('Updated 1 package')
      expect(telemetry.length, 'One detached flush may send zero or one POST; no telemetry delivery guarantee is asserted').toBeLessThanOrEqual(1)
    }
    else {
      report.phase = 'Verifying real thrown lock error before lifecycle or artifacts'; save()
      expect(state(lock), context).toEqual(lockBefore)
      expect(readFileSync(lock, 'utf8'), context).toBe(invalidLock)
      expect(hooks(), context).toEqual([])
      expect(requests, context).toEqual([{ method: 'GET', path: `/binaries/${domain}/metadata.json`, kind: 'metadata' }])
      expect(state(payload), context).toEqual({ present: false })
      expect([...archives.values()].map(archive => present(archive.cachePath)), context).toEqual([false, false])
      expect(output, context).toContain('InvalidLockFile')
      report.actualThrownInstallPrerequisitesPassed = true; save()
      expect(result.code, context).toBe(1)
      expect(output, context).not.toMatch(/Updated \d+ packages?/)
    }
    report.passed = true; report.phase = 'Actual public update installation result qualified'
  }
  catch (error) {
    primaryFailure = { error }; report.passed = false; report.error = fixtureError(error); throw error
  }
  finally {
    await lifecycle.finish({
      report, primaryFailure, stop: () => server?.stop(true), capture, save,
      trace: retained => console.info(`PANTRY_UPDATE_COMPLETION_TRACE:${JSON.stringify({ root, receipt: retained ? join(root, 'completion-result.json') : null, mode, phase: report.phase, passed: report.passed, retained })}`),
    })
  }
}
