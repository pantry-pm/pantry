/**
 * Private scope E2E tests
 *
 * A project pins `@hq` to a Pantry-protocol registry (a local mock here) with
 * `"scopes"` in pantry.json, then installs `@hq/platform` the way a client's
 * CI does: `PANTRY_REGISTRY_TOKEN` set, `pantry install` in the project.
 *
 * Asserted against the real binary:
 *   - ranges and exact pins resolve from `/packages/{name}/versions` by semver;
 *   - metadata, versions and tarball requests all carry the bearer token;
 *   - pantry.lock records `integrity: "sha256:<hex>"`, and a tarball that does
 *     not match the registry's checksum is refused;
 *   - without access (401, or the empty version list a private package shows
 *     a stranger) the install fails with the PANTRY_REGISTRY_TOKEN hint and
 *     nothing is installed - no npm, no fallback.
 *
 * Run with: bun test packages/zig/test/private_scopes_e2e.test.ts
 * Prerequisite: `cd packages/zig && zig build`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { execSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

setDefaultTimeout(120_000)

const PANTRY_BIN = resolve(dirname(import.meta.dir), 'zig-out/bin/pantry')
const TOKEN = 'ptry_pkg_client_ci'
const PACKAGE = '@hq/platform'
const ENCODED = '@hq%2Fplatform'

let pantryAvailable = false
let server: ReturnType<typeof Bun.serve> | undefined
let tarballs: Record<string, Uint8Array> = {}
let requests: Array<{ path: string, auth: string | null }> = []
let mode: 'ok' | 'unauthorized' | 'hidden' | 'bad-checksum' | 'for-sale' = 'ok'
let work: string

function canExecute(command: string): boolean {
  try {
    execSync(`${command} --version`, { stdio: 'pipe' })
    return true
  }
  catch {
    return false
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A real npm-style tarball: `package/package.json` + `package/index.js`. */
function buildTarball(dir: string, version: string): Uint8Array {
  const stage = join(dir, `stage-${version}`)
  mkdirSync(join(stage, 'package'), { recursive: true })
  writeFileSync(join(stage, 'package', 'package.json'), JSON.stringify({ name: PACKAGE, version }))
  writeFileSync(join(stage, 'package', 'index.js'), `module.exports = '${version}'\n`)
  const out = join(dir, `platform-${version}.tgz`)
  const tar = spawnSync('tar', ['-czf', out, '-C', stage, 'package'])
  if (tar.status !== 0)
    throw new Error(`tar failed: ${tar.stderr}`)
  return new Uint8Array(readFileSync(out))
}

beforeAll(() => {
  pantryAvailable = existsSync(PANTRY_BIN) && canExecute(PANTRY_BIN)
  if (!pantryAvailable) {
    console.warn('No runnable pantry binary - skipping private scope e2e tests (cd packages/zig && zig build)')
    return
  }

  const fixtures = join(tmpdir(), `pantry-scopes-fixtures-${Date.now()}`)
  mkdirSync(fixtures, { recursive: true })
  tarballs = {
    '1.2.0': buildTarball(fixtures, '1.2.0'),
    '1.4.0': buildTarball(fixtures, '1.4.0'),
    '2.0.0': buildTarball(fixtures, '2.0.0'),
  }

  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url)
      const auth = req.headers.get('authorization')
      requests.push({ path: url.pathname, auth })

      const prefix = `/packages/${ENCODED}`
      if (!url.pathname.startsWith(prefix))
        return Response.json({ error: 'Package not found' }, { status: 404 })

      const authorized = auth === `Bearer ${TOKEN}`
      // A private package for sale answers an unentitled caller with 402 on
      // metadata, versions and tarball alike.
      if (mode === 'for-sale') {
        const buyUrl = `${url.origin}/packages/%40hq%2Fplatform/buy`
        return Response.json({
          error: 'Payment required',
          package: PACKAGE,
          price: 900,
          currency: 'usd',
          formattedPrice: '$9.00',
          buyUrl,
          checkoutUrl: buyUrl,
          message: `${PACKAGE} costs $9.00. Buy it with: pantry buy ${PACKAGE} (or open ${buyUrl})`,
          forSale: true,
          publisher: 'HQ',
        }, { status: 402, headers: { 'cache-control': 'no-store' } })
      }
      if (mode === 'unauthorized' && !authorized)
        return Response.json({ error: 'Authentication required' }, { status: 401 })
      // The registry shows a stranger an empty version list for a private package.
      if (mode === 'hidden' && url.pathname === `${prefix}/versions`)
        return Response.json({ versions: [] })
      if (!authorized && mode !== 'hidden')
        return Response.json({ error: 'Authentication required' }, { status: 401 })

      const rest = url.pathname.slice(prefix.length)
      if (rest === '/versions')
        return Response.json({ versions: Object.keys(tarballs) })

      const tarballMatch = rest.match(/^\/([^/]+)\/tarball$/)
      if (tarballMatch) {
        const bytes = tarballs[tarballMatch[1]]
        return bytes ? new Response(bytes, { headers: { 'content-type': 'application/gzip' } }) : new Response('nope', { status: 404 })
      }

      const versionMatch = rest.match(/^\/([^/]+)$/)
      if (versionMatch && tarballs[versionMatch[1]]) {
        const version = versionMatch[1]
        const checksum = mode === 'bad-checksum' ? '0'.repeat(64) : sha256(tarballs[version])
        return Response.json({
          name: PACKAGE,
          version,
          tarballUrl: `${url.origin}${prefix}/${version}/tarball`,
          checksum: `sha256:${checksum}`,
          publishConfig: { access: 'restricted' },
        })
      }
      return Response.json({ error: 'Package version not found' }, { status: 404 })
    },
  })
})

afterAll(() => {
  server?.stop(true)
})

beforeEach(() => {
  requests = []
  mode = 'ok'
  work = join(tmpdir(), `pantry-scopes-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(work, 'project'), { recursive: true })
  mkdirSync(join(work, 'home'), { recursive: true })
})

afterEach(() => {
  try {
    rmSync(work, { recursive: true, force: true })
  }
  catch {}
})

function writeProject(constraint: string): string {
  const project = join(work, 'project')
  writeFileSync(join(project, 'pantry.json'), JSON.stringify({
    name: 'client-app',
    version: '0.0.0',
    scopes: { '@hq': `http://127.0.0.1:${server!.port}` },
    dependencies: { [PACKAGE]: constraint },
  }, null, 2))
  return project
}

async function install(project: string, token: string | null): Promise<{ code: number, output: string }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: join(work, 'home'),
    NO_COLOR: '1',
    CI: '1',
  }
  if (token)
    env.PANTRY_REGISTRY_TOKEN = token
  // Async spawn: the mock registry lives on this process's event loop.
  const proc = Bun.spawn({ cmd: [PANTRY_BIN, 'install'], cwd: project, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, output: stdout + stderr }
}

function installedVersion(project: string): string | null {
  const manifest = join(project, 'pantry', PACKAGE, 'package.json')
  if (!existsSync(manifest))
    return null
  return JSON.parse(readFileSync(manifest, 'utf8')).version
}

describe('pinned scopes', () => {
  it('resolves a range from the pinned registry, with the token on every request, and locks integrity', async () => {
    if (!pantryAvailable)
      return
    const project = writeProject('^1.2.0')
    const { code, output } = await install(project, TOKEN)
    expect(code, output).toBe(0)
    expect(installedVersion(project)).toBe('1.4.0')

    const paths = requests.map(r => r.path)
    expect(paths).toContain(`/packages/${ENCODED}/versions`)
    expect(paths).toContain(`/packages/${ENCODED}/1.4.0`)
    expect(paths).toContain(`/packages/${ENCODED}/1.4.0/tarball`)
    for (const r of requests)
      expect(r.auth).toBe(`Bearer ${TOKEN}`)

    const lock = readFileSync(join(project, 'pantry.lock'), 'utf8')
    expect(lock).toContain(`sha256:${sha256(tarballs['1.4.0'])}`)
  })

  it('resolves an exact pin from the pinned registry, not npm', async () => {
    if (!pantryAvailable)
      return
    const project = writeProject('1.2.0')
    const { code, output } = await install(project, TOKEN)
    expect(code, output).toBe(0)
    expect(installedVersion(project)).toBe('1.2.0')
    expect(requests.map(r => r.path)).toContain(`/packages/${ENCODED}/versions`)
  })

  it('fails with the token hint on 401 and installs nothing', async () => {
    if (!pantryAvailable)
      return
    mode = 'unauthorized'
    const project = writeProject('^1.2.0')
    const { code, output } = await install(project, null)
    expect(code).not.toBe(0)
    expect(output).toContain('PANTRY_REGISTRY_TOKEN')
    expect(output).toContain('no other registry was tried')
    expect(installedVersion(project)).toBeNull()
  })

  it('treats the empty version list a stranger sees as not available', async () => {
    if (!pantryAvailable)
      return
    mode = 'hidden'
    const project = writeProject('1.4.0')
    const { code, output } = await install(project, null)
    expect(code).not.toBe(0)
    expect(output).toContain('is not available from')
    expect(output).toContain('PANTRY_REGISTRY_TOKEN')
    expect(installedVersion(project)).toBeNull()
  })

  it('repeats what the registry says when a private package is for sale (402)', async () => {
    if (!pantryAvailable)
      return
    mode = 'for-sale'
    const project = writeProject('^1.2.0')
    const { code, output } = await install(project, TOKEN)
    expect(code).not.toBe(0)
    expect(output).toContain(`${PACKAGE} costs $9.00. Buy it with: pantry buy ${PACKAGE}`)
    expect(output).toContain('/packages/%40hq%2Fplatform/buy')
    expect(output).toContain('no other registry was tried')
    expect(output).not.toContain('PANTRY_REGISTRY_TOKEN')
    expect(installedVersion(project)).toBeNull()
    // Only the pinned registry was asked.
    expect(requests.length).toBeGreaterThan(0)
  })

  it('refuses a tarball that does not match the registry checksum', async () => {
    if (!pantryAvailable)
      return
    mode = 'bad-checksum'
    const project = writeProject('1.4.0')
    const { code, output } = await install(project, TOKEN)
    expect(code, output).not.toBe(0)
    expect(installedVersion(project)).toBeNull()
  })
})

describe('pantry access', () => {
  let api: ReturnType<typeof Bun.serve> | undefined
  let seen: Array<{ method: string, path: string, auth: string | null, body: string }> = []

  beforeAll(() => {
    if (!pantryAvailable)
      return
    api = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url)
        const body = await req.text()
        seen.push({ method: req.method, path: url.pathname, auth: req.headers.get('authorization'), body })
        const access = `/packages/${ENCODED}/access`
        const tokens = `/packages/${ENCODED}/tokens`
        if (url.pathname === access && req.method === 'GET')
          return Response.json({ grants: [{ subject: 'user:1', email: 'dev@client.com', expiresAt: null, createdAt: '2026-10-30T00:00:00Z' }] })
        if (url.pathname === access && req.method === 'PUT')
          return Response.json({ grant: { subject: 'user:1', email: JSON.parse(body).email, expiresAt: JSON.parse(body).expiresAt ?? null } })
        if (url.pathname === access && req.method === 'DELETE') {
          return JSON.parse(body).email === 'dev@client.com'
            ? Response.json({ revoked: true })
            : Response.json({ error: 'No such grant' }, { status: 404 })
        }
        if (url.pathname === tokens && req.method === 'POST')
          return Response.json({ token: 'ptry_pkg_new', id: 'tok_1', name: JSON.parse(body).name, expiresAt: null }, { status: 201 })
        if (url.pathname === tokens && req.method === 'GET')
          return Response.json({ tokens: [{ id: 'tok_1', name: 'acme-ci', expiresAt: null, createdAt: '2026-10-30T00:00:00Z' }] })
        if (url.pathname.startsWith(`${tokens}/`) && req.method === 'DELETE')
          return url.pathname.endsWith('/tok_1') ? Response.json({ revoked: true }) : Response.json({ error: 'Token not found' }, { status: 404 })
        return Response.json({ error: 'not found' }, { status: 404 })
      },
    })
  })

  afterAll(() => {
    api?.stop(true)
  })

  async function access(...args: string[]): Promise<{ code: number, output: string }> {
    const proc = Bun.spawn({
      cmd: [PANTRY_BIN, 'access', ...args, '--registry', `http://127.0.0.1:${api!.port}`, '--token', 'ptry_publisher'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(work, 'home'), NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code: await proc.exited, output: stdout + stderr }
  }

  it('lists, grants and revokes against the access API with the publisher token', async () => {
    if (!pantryAvailable)
      return
    seen = []
    expect((await access('list', PACKAGE)).output).toContain('dev@client.com')

    const granted = await access('grant', PACKAGE, 'new@client.com', '--expires-in-days', '30')
    expect(granted.code, granted.output).toBe(0)
    const put = seen.find(r => r.method === 'PUT')!
    expect(put.path).toBe(`/packages/${ENCODED}/access`)
    expect(JSON.parse(put.body).email).toBe('new@client.com')
    expect(JSON.parse(put.body).expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

    const revoked = await access('revoke', PACKAGE, 'dev@client.com')
    expect(revoked.code, revoked.output).toBe(0)
    expect(JSON.parse(seen.find(r => r.method === 'DELETE')!.body)).toEqual({ email: 'dev@client.com' })

    const missing = await access('revoke', PACKAGE, 'nobody@client.com')
    expect(missing.code).not.toBe(0)
    expect(missing.output).toContain('has no grant')

    for (const r of seen)
      expect(r.auth).toBe('Bearer ptry_publisher')
  })

  it('issues, lists and revokes package tokens', async () => {
    if (!pantryAvailable)
      return
    seen = []
    const issued = await access('token', PACKAGE, '--name', 'acme-ci', '--expires-in-days', '90')
    expect(issued.code, issued.output).toBe(0)
    expect(issued.output).toContain('ptry_pkg_new')
    expect(issued.output).toContain('PANTRY_REGISTRY_TOKEN')
    expect(JSON.parse(seen.find(r => r.method === 'POST')!.body)).toEqual({ name: 'acme-ci', expiresInDays: 90 })

    expect((await access('tokens', PACKAGE)).output).toContain('tok_1')
    expect((await access('token-revoke', PACKAGE, 'tok_1')).code).toBe(0)
    const unknown = await access('token-revoke', PACKAGE, 'tok_2')
    expect(unknown.code).not.toBe(0)
    expect(unknown.output).toContain('no package token tok_2')

    expect((await access('grant', PACKAGE, 'x@y.z', '--expires-in-days', '0')).code).not.toBe(0)
  })
})
