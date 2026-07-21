import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { InMemoryAnalytics } from './analytics'
import { createLocalRegistry } from './registry'
import { createServer } from './server'
import { getAvailablePort } from './test-utils'
import { InMemoryZigStorage } from './zig'

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

  function publish(version = '1.0.0', authorization = token): Promise<Response> {
    const form = new FormData()
    form.append('tarball', new File([Buffer.from(`zig package ${version}`)], `example-${version}.tar.gz`))
    form.append('manifest', `.name = .example_package,\n.version = "${version}",`)
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
  })

  it('publishes canonical metadata and content-addressed evidence', async () => {
    const response = await publish()
    const body = await response.json() as any

    expect(response.status).toBe(201)
    expect(body.message).toBe('Published example-package@1.0.0')
    expect(body.hash).toMatch(/^1220[a-f0-9]{64}$/)
    expect(body.tarballUrl).toBe(`${baseUrl}/zig/packages/example-package/1.0.0/tarball`)
    expect(body.fetchCommand).toContain('zig fetch --save')
    expect(body.dependency).toContain('.example-package')
  })

  it('retrieves latest and exact version metadata and lists versions', async () => {
    expect((await publish('1.0.0')).status).toBe(201)
    expect((await publish('2.0.0')).status).toBe(201)

    const latest = await (await fetch(`${baseUrl}/zig/packages/example-package`)).json() as any
    const exact = await (await fetch(`${baseUrl}/zig/packages/example-package/1.0.0`)).json() as any
    const versions = await (await fetch(`${baseUrl}/zig/packages/example-package/versions`)).json() as any

    expect(latest.version).toBe('2.0.0')
    expect(exact.version).toBe('1.0.0')
    expect(versions.versions).toEqual(['2.0.0', '1.0.0'])
  })

  it('downloads the exact published tarball and resolves its hash', async () => {
    const published = await (await publish()).json() as any
    const tarball = await fetch(`${baseUrl}/zig/packages/example-package/1.0.0/tarball`)
    const hashLookup = await fetch(`${baseUrl}/zig/hash/${published.hash}`)

    expect(tarball.status).toBe(200)
    expect(tarball.headers.get('content-type')).toBe('application/gzip')
    expect(await tarball.text()).toBe('zig package 1.0.0')
    expect((await hashLookup.json() as any).name).toBe('example-package')
  })

  it('searches published packages with a bounded JSON response', async () => {
    expect((await publish()).status).toBe(201)
    const response = await fetch(`${baseUrl}/zig/search?q=example&limit=1`)
    const body = await response.json() as any

    expect(response.status).toBe(200)
    expect(body.results).toHaveLength(1)
    expect(body.results[0].name).toBe('example-package')
  })

  it('rejects duplicate immutable versions', async () => {
    expect((await publish()).status).toBe(201)
    const duplicate = await publish()

    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'Version already exists' })
  })

  it('requires the current token to delete a package', async () => {
    expect((await publish()).status).toBe(201)
    expect((await fetch(`${baseUrl}/zig/packages/example-package`, { method: 'DELETE' })).status).toBe(401)

    const deleted = await fetch(`${baseUrl}/zig/packages/example-package`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(deleted.status).toBe(200)
    expect((await fetch(`${baseUrl}/zig/packages/example-package`)).status).toBe(404)
  })
})
