/**
 * Package deprecation E2E tests
 *
 * The built CLI against a real registry server (packages/registry, in
 * process, in-memory storage):
 *
 *   - `pantry deprecate @hq/kit-probe "<message>"` deprecates a scoped package
 *     with the owner's stored-style token, and `--undo` takes it back;
 *   - a stranger's token is refused by the registry, with the CLI's hint;
 *   - `pantry install`, and `pantry ci` on a fresh checkout of the lockfile,
 *     in a project that pins `@hq` to the registry print exactly one
 *     `warn: @hq/kit-probe@1.1.0 is deprecated: <message>` line and still
 *     install (exit 0);
 *   - after `--undo` the warning is gone.
 *
 * Run with: bun test packages/zig/test/deprecate_e2e.test.ts
 * Prerequisite: `cd packages/zig && zig build`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from '../../registry/src/server'
import { Registry } from '../../registry/src/registry'
import { AuthService, InMemoryAuthStorage } from '../../registry/src/auth'
import { InMemoryAnalytics } from '../../registry/src/analytics'
import { getAvailablePort } from '../../registry/src/test-utils'

setDefaultTimeout(120_000)

const PANTRY_BIN = process.env.PANTRY_E2E_BIN || resolve(dirname(import.meta.dir), 'zig-out/bin/pantry')
const PACKAGE = '@hq/kit-probe'
const MESSAGE = 'Empty test package; nothing to install here.'
const ADMIN_TOKEN = 'ptry_admin_token_for_deprecate_e2e'

let pantryAvailable = false
let server: ReturnType<typeof createServer> | undefined
let registry: Registry
let base = ''
let ownerToken = ''
let strangerToken = ''
let fixtures = ''
let work = ''
const savedRegistryToken = process.env.PANTRY_REGISTRY_TOKEN

function canExecute(command: string): boolean {
  try {
    execSync(`${command} --version`, { stdio: 'pipe' })
    return true
  }
  catch {
    return false
  }
}

/** A real npm-style tarball: `package/package.json` + `package/index.js`. */
function buildTarball(version: string): Uint8Array {
  const stage = join(fixtures, `stage-${version}`)
  mkdirSync(join(stage, 'package'), { recursive: true })
  writeFileSync(join(stage, 'package', 'package.json'), JSON.stringify({ name: PACKAGE, version }))
  writeFileSync(join(stage, 'package', 'index.js'), `module.exports = '${version}'\n`)
  const out = join(fixtures, `kit-probe-${version}.tgz`)
  const tar = spawnSync('tar', ['-czf', out, '-C', stage, 'package'])
  if (tar.status !== 0)
    throw new Error(`tar failed: ${tar.stderr}`)
  return new Uint8Array(readFileSync(out))
}

async function publish(version: string): Promise<void> {
  const form = new FormData()
  form.set('metadata', JSON.stringify({ name: PACKAGE, version, description: 'an empty probe' }))
  form.set('tarball', new File([buildTarball(version)], `kit-probe-${version}.tgz`))
  const res = await fetch(`${base}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` }, body: form })
  if (res.status !== 201)
    throw new Error(`publish ${version} failed: ${res.status} ${await res.text()}`)
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: join(work, 'home'),
    NO_COLOR: '1',
    CI: '1',
    ...extra,
  }
}

/** Async spawn: the registry lives on this process's event loop. */
async function pantry(args: string[], options: { cwd?: string, env?: Record<string, string> } = {}): Promise<{ code: number, output: string }> {
  const proc = Bun.spawn({ cmd: [PANTRY_BIN, ...args], cwd: options.cwd ?? work, env: options.env ?? env(), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, output: stdout + stderr }
}

function writeProject(): string {
  const project = join(work, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'pantry.json'), JSON.stringify({
    name: 'client-app',
    version: '0.0.0',
    scopes: { '@hq': base },
    dependencies: { [PACKAGE]: '^1.0.0' },
  }, null, 2))
  return project
}

function installedVersion(project: string): string | null {
  const manifest = join(project, 'pantry', PACKAGE, 'package.json')
  return existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : null
}

function warnings(output: string): string[] {
  return output.split('\n').filter(line => line.startsWith('warn: ') && line.includes('deprecated'))
}

beforeAll(async () => {
  pantryAvailable = existsSync(PANTRY_BIN) && canExecute(PANTRY_BIN)
  if (!pantryAvailable) {
    console.warn('No runnable pantry binary - skipping deprecation e2e tests (cd packages/zig && zig build)')
    return
  }

  process.env.PANTRY_REGISTRY_TOKEN = ADMIN_TOKEN
  fixtures = join(tmpdir(), `pantry-deprecate-fixtures-${Date.now()}`)
  mkdirSync(fixtures, { recursive: true })

  const port = await getAvailablePort()
  base = `http://127.0.0.1:${port}`
  registry = new Registry({ s3Bucket: 'local', dynamoTable: 'local', baseUrl: base, npmFallback: false })
  const authStorage = new InMemoryAuthStorage()
  const auth = new AuthService(authStorage)
  server = createServer(registry, port, new InMemoryAnalytics(), undefined, undefined, undefined, authStorage)
  server.start()

  await auth.signup('owner@hq.training', 'owner', 'password123')
  ownerToken = (await auth.createApiToken('owner@hq.training', 'cli', { permissions: ['publish', 'read'] })).token
  await auth.signup('stranger@elsewhere.example', 'stranger', 'password123')
  strangerToken = (await auth.createApiToken('stranger@elsewhere.example', 'cli', { permissions: ['publish', 'read'] })).token

  await publish('1.0.0')
  await publish('1.1.0')
})

afterAll(async () => {
  await server?.stop(true)
  if (savedRegistryToken === undefined) delete process.env.PANTRY_REGISTRY_TOKEN
  else process.env.PANTRY_REGISTRY_TOKEN = savedRegistryToken
  if (fixtures) rmSync(fixtures, { recursive: true, force: true })
})

beforeEach(() => {
  work = join(tmpdir(), `pantry-deprecate-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(work, 'home'), { recursive: true })
})

afterEach(async () => {
  // Every test starts from a package that is not deprecated.
  if (pantryAvailable)
    await fetch(`${base}/packages/@hq%2Fkit-probe/deprecation`, { method: 'DELETE', headers: { Authorization: `Bearer ${ownerToken}` } })
  rmSync(work, { recursive: true, force: true })
})

describe('pantry deprecate', () => {
  it('deprecates a scoped package and undoes it', async () => {
    if (!pantryAvailable) return

    const deprecated = await pantry(['deprecate', PACKAGE, MESSAGE, '--registry', base, '--token', ownerToken])
    expect(deprecated.code, deprecated.output).toBe(0)
    expect(deprecated.output).toContain(`Deprecated ${PACKAGE}: ${MESSAGE}`)
    expect(deprecated.output).toContain(`pantry deprecate ${PACKAGE} --undo`)

    for (const path of [`/packages/${PACKAGE}/1.0.0`, `/packages/@hq%2Fkit-probe/1.1.0`, `/packages/%40hq%2fkit-probe`]) {
      const meta = await (await fetch(`${base}${path}`)).json() as any
      expect({ path, deprecated: meta.deprecated }).toEqual({ path, deprecated: MESSAGE })
    }
    const record = await registry.getPublisherPackageRecord(PACKAGE)
    expect(record?.settings).toMatchObject({ deprecated: true, deprecationMessage: MESSAGE })

    // The token can come from the environment, the way CI passes it.
    const undone = await pantry(['deprecate', PACKAGE, '--undo'], { env: env({ PANTRY_REGISTRY_URL: base, PANTRY_REGISTRY_TOKEN: ownerToken }) })
    expect(undone.code, undone.output).toBe(0)
    expect(undone.output).toContain(`${PACKAGE} is no longer deprecated.`)
    expect(((await (await fetch(`${base}/packages/@hq%2Fkit-probe/1.1.0`)).json()) as any).deprecated).toBeUndefined()
  })

  it('uses the registry default message when none is given', async () => {
    if (!pantryAvailable) return
    const res = await pantry(['deprecate', PACKAGE, '--registry', base, '--token', ownerToken])
    expect(res.code, res.output).toBe(0)
    expect(res.output).toContain(`Deprecated ${PACKAGE}: This package is deprecated`)
  })

  it('is refused for someone who does not manage the package', async () => {
    if (!pantryAvailable) return
    const res = await pantry(['deprecate', PACKAGE, 'mine now', '--registry', base, '--token', strangerToken])
    expect(res.code).not.toBe(0)
    expect(res.output).toContain(`Could not deprecate ${PACKAGE}`)
    expect(res.output).toContain('Only the package\'s publisher, their team, or a registry admin')
    expect(((await (await fetch(`${base}/packages/@hq%2Fkit-probe`)).json()) as any).deprecated).toBeUndefined()

    const noToken = await pantry(['deprecate', PACKAGE, '--registry', base])
    expect(noToken.code).not.toBe(0)
    expect(noToken.output).toContain('no credential')

    const both = await pantry(['deprecate', PACKAGE, 'why', '--undo', '--registry', base, '--token', ownerToken])
    expect(both.code).not.toBe(0)
    expect(both.output).toContain('--undo takes no message')
  })
})

describe('installing a deprecated package', () => {
  it('warns once on install and ci, and still installs', async () => {
    if (!pantryAvailable) return
    expect((await pantry(['deprecate', PACKAGE, MESSAGE, '--registry', base, '--token', ownerToken])).code).toBe(0)

    const project = writeProject()
    const install = await pantry(['install'], { cwd: project, env: env({ PANTRY_REGISTRY_TOKEN: ownerToken }) })
    expect(install.code, install.output).toBe(0)
    expect(installedVersion(project)).toBe('1.1.0')
    expect(warnings(install.output)).toEqual([`warn: ${PACKAGE}@1.1.0 is deprecated: ${MESSAGE}`])

    // A CI checkout has the lockfile but nothing installed yet. (A tree that
    // is already up to date resolves nothing, so has nothing to warn about.)
    expect(existsSync(join(project, 'pantry.lock'))).toBe(true)
    rmSync(join(project, 'pantry'), { recursive: true, force: true })
    const ci = await pantry(['ci'], { cwd: project, env: env({ PANTRY_REGISTRY_TOKEN: ownerToken }) })
    expect(ci.code, ci.output).toBe(0)
    expect(warnings(ci.output)).toEqual([`warn: ${PACKAGE}@1.1.0 is deprecated: ${MESSAGE}`])
    expect(installedVersion(project)).toBe('1.1.0')
  })

  it('does not warn once the deprecation is undone', async () => {
    if (!pantryAvailable) return
    expect((await pantry(['deprecate', PACKAGE, MESSAGE, '--registry', base, '--token', ownerToken])).code).toBe(0)
    expect((await pantry(['deprecate', PACKAGE, '--undo', '--registry', base, '--token', ownerToken])).code).toBe(0)

    const project = writeProject()
    const install = await pantry(['install'], { cwd: project, env: env({ PANTRY_REGISTRY_TOKEN: ownerToken }) })
    expect(install.code, install.output).toBe(0)
    expect(installedVersion(project)).toBe('1.1.0')
    expect(warnings(install.output)).toEqual([])
  })
})
