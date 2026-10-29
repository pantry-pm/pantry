import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryAnalytics } from './analytics'
import { createLocalRegistry } from './registry'
import { createServer } from './server'
import { getAvailablePort } from './test-utils'
import { InMemoryZigStorage } from './zig'
import { managedRegistryZig } from './zig-native-hash'
import { zigPackageFixture } from './zig-package-fixture'

// These routes execute the declared native compiler with a 120-second budget.
// Leave time for request cleanup instead of the default five-second unit limit.
describe('Zig registry routes', () => {
  let port: number
  let baseUrl: string
  let server: ReturnType<typeof createServer>
  let token: string

  beforeEach(async () => {
    token = `zig-test-${crypto.randomUUID()}`
    process.env.PANTRY_REGISTRY_TOKEN = token
    port = await getAvailablePort()
    baseUrl = `http://localhost:${port}`
    server = createServer(
      createLocalRegistry(baseUrl),
      port,
      new InMemoryAnalytics(),
      new InMemoryZigStorage(),
    )
    server.start()
  })

  afterEach(() => {
    server.stop()
    delete process.env.PANTRY_REGISTRY_TOKEN
  })

  async function publish(version = '1.0.0', authorization = token): Promise<Response> {
    const form = new FormData()
    form.append('tarball', new File([new Uint8Array(await zigPackageFixture(version))], `graphics_package_consumer-${version}.tar.gz`))
    form.append('manifest', `.name = .graphics_package_consumer,\n.version = "${version}",`)
    form.append('description', 'Example Zig package')
    return fetch(`${baseUrl}/zig/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authorization}` },
      body: form,
    })
  }

  it('fails closed when publishing without authorization', async () => {
    const form = new FormData()
    form.append('tarball', new File([Buffer.from('data')], 'example-1.0.0.tar.gz'))
    const response = await fetch(`${baseUrl}/zig/publish`, { method: 'POST', body: form })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authorization required' })
  })

  it('uses the current token after runtime rotation', async () => {
    const rotatedToken = `rotated-${crypto.randomUUID()}`
    process.env.PANTRY_REGISTRY_TOKEN = rotatedToken

    expect((await publish('1.0.0', token)).status).toBe(401)
    expect((await publish('1.0.0', rotatedToken)).status).toBe(201)
  }, 130_000)

  it('publishes canonical metadata and content-addressed evidence', async () => {
    const response = await publish()
    const body = await response.json() as any

    expect(response.status).toBe(201)
    expect(body.message).toBe('Published graphics-package-consumer@1.0.0')
    expect(body.hash).toBe('graphics_package_consumer-1.0.0-eF_X1KAAAAB7sPq4wQFLI6Urz5wPpAnB_liZ_wFl9Csi')
    expect(body.tarballUrl).toBe(`${baseUrl}/zig/packages/graphics-package-consumer/1.0.0/tarball`)
    expect(body.fetchCommand).toContain('zig fetch --save')
    expect(body.artifactSha256).toBe(createHash('sha256').update(await zigPackageFixture()).digest('hex'))
    expect(body.dependency).toContain('.@"graphics-package-consumer"')
  }, 130_000)

  it('publishes a dependency entry a clean native Zig consumer resolves', async () => {
    // The qualification #248 asked for. The registry used to advertise the
    // tarball's SHA-256 under a `1220` prefix, which is a different identity
    // from a Zig package hash: the archive downloaded and matched that digest,
    // and a consumer still refused the dependency with "invalid hash:
    // incomplete". Nothing in this suite noticed, because every assertion
    // compared the registry against itself. This one hands the advertised
    // entry to the compiler and lets it judge.
    const zig = process.env.PANTRY_ZIG_BIN || managedRegistryZig() || Bun.which('zig')
    expect(zig).toBeTruthy()

    const body = await (await publish()).json() as any
    expect(body.hash).not.toMatch(/^1220/)

    // A cache of its own, so a hit from another test cannot stand in for a
    // fetch that would otherwise fail.
    const workspace = await mkdtemp(join(tmpdir(), 'pantry-zig-consumer-'))
    const cache = join(workspace, 'cache')
    try {
      // Spawned asynchronously, never with spawnSync: the registry under test
      // serves the tarball from THIS process, so blocking the loop while the
      // compiler fetches deadlocks the pair until the test times out.
      async function zigRun(...args: string[]): Promise<{ code: number, out: string, err: string }> {
        const child = Bun.spawn([zig!, ...args], {
          cwd: workspace,
          env: { ...process.env, ZIG_GLOBAL_CACHE_DIR: cache },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return { code, out, err }
      }

      // What the compiler computes for the served archive has to be exactly
      // what the registry told consumers to write down.
      const fetched = await zigRun('fetch', body.tarballUrl)
      // Not an empty stderr: the compiler writes housekeeping warnings there
      // (a temp dir it could not remove, for one), and failing on those tests
      // the host rather than the hash. The exit status and the hash are the
      // contract.
      expect(fetched.err).not.toContain('error:')
      expect(fetched.code).toBe(0)
      expect(fetched.out.trim()).toBe(body.hash)

      // And the identity a consumer actually records has to be that same
      // hash: `zig fetch --save` writes the dependency into build.zig.zon
      // exactly as a person adding this package would.
      // `zig fetch --save` edits a real project, so it needs both files.
      await writeFile(join(workspace, 'build.zig'), 'pub fn build(_: *@import("std").Build) void {}\n')
      await writeFile(
        join(workspace, 'build.zig.zon'),
        // The fingerprint is derived from the package name, so it is fixed for
        // `.consumer` rather than arbitrary — the compiler rejects a wrong one
        // and prints the value it wants, which is where this came from.
        `.{\n    .name = .consumer,\n    .version = "0.0.0",\n    .fingerprint = 0x705b372777268903,\n    .paths = .{""},\n}\n`,
      )
      const saved = await zigRun('fetch', '--save=dep', body.tarballUrl)
      expect(`${saved.code} ${saved.err}`.replace(/warning\(fetch\):[^\n]*\n?/g, '').trim()).toBe('0')
      const manifest = await readFile(join(workspace, 'build.zig.zon'), 'utf8')
      expect(manifest).toContain(body.hash)
      expect(manifest).toContain(body.tarballUrl)
    }
    finally { await rm(workspace, { recursive: true, force: true }) }
  }, 130_000)

  it('retrieves latest and exact version metadata and lists versions', async () => {
    expect((await publish('1.0.0')).status).toBe(201)
    expect((await publish('2.0.0')).status).toBe(201)

    const latest = await (await fetch(`${baseUrl}/zig/packages/graphics-package-consumer`)).json() as any
    const exact = await (await fetch(`${baseUrl}/zig/packages/graphics-package-consumer/1.0.0`)).json() as any
    const versions = await (await fetch(`${baseUrl}/zig/packages/graphics-package-consumer/versions`)).json() as any

    expect(latest.version).toBe('2.0.0')
    expect(exact.version).toBe('1.0.0')
    expect(versions.versions).toEqual(['2.0.0', '1.0.0'])
  }, 130_000)

  it('downloads the exact published tarball and resolves its hash', async () => {
    const published = await (await publish()).json() as any
    const tarball = await fetch(`${baseUrl}/zig/packages/graphics-package-consumer/1.0.0/tarball`)
    const hashLookup = await fetch(`${baseUrl}/zig/hash/${published.hash}`)

    expect(tarball.status).toBe(200)
    expect(tarball.headers.get('content-type')).toBe('application/gzip')
    expect(Buffer.from(await tarball.arrayBuffer()).toString('base64')).toBe((await zigPackageFixture()).toString('base64'))
    expect((await hashLookup.json() as any).name).toBe('graphics-package-consumer')
  }, 130_000)

  it('searches published packages with a bounded JSON response', async () => {
    expect((await publish()).status).toBe(201)
    const response = await fetch(`${baseUrl}/zig/search?q=graphics&limit=1`)
    const body = await response.json() as any

    expect(response.status).toBe(200)
    expect(body.results).toHaveLength(1)
    expect(body.results[0].name).toBe('graphics-package-consumer')
  }, 130_000)

  it('rejects a malformed clean archive without publishing metadata', async () => {
    const form = new FormData()
    form.append('tarball', new File([Buffer.from('not an archive')], 'invalid-1.0.0.tar.gz'))
    form.append('manifest', '.{ .name = .invalid, .version = "1.0.0" }')
    const response = await fetch(`${baseUrl}/zig/publish`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    })
    expect(response.status).toBe(422)
    expect((await fetch(`${baseUrl}/zig/packages/invalid/1.0.0`)).status).toBe(404)
  }, 130_000)

  it('fails closed when the declared native compiler is unavailable', async () => {
    const previous = process.env.PANTRY_ZIG_BIN
    process.env.PANTRY_ZIG_BIN = '/missing-registry-zig-executable'
    try {
      expect((await publish()).status).toBe(503)
      expect((await fetch(`${baseUrl}/zig/packages/graphics-package-consumer/1.0.0`)).status).toBe(404)
    }
    finally {
      if (previous === undefined) delete process.env.PANTRY_ZIG_BIN
      else process.env.PANTRY_ZIG_BIN = previous
    }
  }, 130_000)

  it('rejects duplicate immutable versions', async () => {
    expect((await publish()).status).toBe(201)
    const duplicate = await publish()

    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'Version already exists' })
  }, 130_000)

  it('requires the current token to delete a package', async () => {
    expect((await publish()).status).toBe(201)
    expect((await fetch(`${baseUrl}/zig/packages/graphics-package-consumer`, { method: 'DELETE' })).status).toBe(401)

    const deleted = await fetch(`${baseUrl}/zig/packages/graphics-package-consumer`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(deleted.status).toBe(200)
    expect((await fetch(`${baseUrl}/zig/packages/graphics-package-consumer`)).status).toBe(404)
  }, 130_000)
})
