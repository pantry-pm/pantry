/**
 * Private packages, end to end against a running server: published private
 * with `publishConfig.access: "restricted"`, invisible on every read surface to
 * anyone the owner hasn't let in, and readable by the owner, their team, admins,
 * granted accounts and package-scoped CI tokens.
 *
 * "Invisible" is checked the strict way: a refused caller must get byte-for-byte
 * the response a never-published name gets, so the 404 itself leaks nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { createServer } from './server'
import { Registry } from './registry'
import { AuthService, DynamoDBAuthStorage, hashToken, InMemoryAuthStorage } from './auth'
import { InMemoryAnalytics } from './analytics'
import { accountSubject } from './paywall'
import { canReadPackage, parseGrantExpiry, restrictedAccessRequested } from './private-packages'
import { InMemoryMetadataStorage } from './storage/metadata'
import { DynamoDBMetadataStorage } from './storage/dynamodb-metadata'
import { getAvailablePort } from './test-utils'

const ADMIN_TOKEN = 'ptry_admin_token_for_private_package_tests'
const PRIVATE = '@hq/platform'
const ENCODED = encodeURIComponent(PRIVATE)
const MISSING = '@hq/never-published'

/** A gzip'd tarball holding one `package/package.json`. */
function tgz(manifest: Record<string, unknown>): Uint8Array<ArrayBuffer> {
  const body = Buffer.from(JSON.stringify(manifest))
  const header = Buffer.alloc(512)
  header.write('package/package.json', 0, 100)
  header.write('0000644\0', 100, 8)
  header.write('0000000\0', 108, 8)
  header.write('0000000\0', 116, 8)
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12)
  header.write('00000000000\0', 136, 12)
  header.fill(0x20, 148, 156)
  header[156] = 48
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  const gz = gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]))
  const out = new Uint8Array(new ArrayBuffer(gz.length))
  out.set(gz)
  return out
}

describe('private packages', () => {
  let port: number
  let baseUrl: string
  let server: ReturnType<typeof createServer>
  let registry: Registry
  let auth: AuthService
  let authStorage: InMemoryAuthStorage
  let analytics: InMemoryAnalytics
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = ['PANTRY_REGISTRY_TOKEN', 'PANTRY_TOKEN', 'STRIPE_SECRET_KEY', 'REGISTRY_VISIBILITY', 'BASE_URL']

  let ownerToken: string
  let ownerReadToken: string
  let memberToken: string
  let clientToken: string
  let clientTeamMemberToken: string
  let strangerToken: string

  async function account(email: string, permissions: ('publish' | 'read')[] = ['publish', 'read']): Promise<string> {
    await auth.signup(email, email.split('@')[0], 'password123')
    const { token } = await auth.createApiToken(email, 'test', { permissions })
    return token
  }

  async function session(email: string): Promise<string> {
    const { sessionToken } = await auth.login(email, 'password123')
    return sessionToken
  }

  async function publish(
    name: string,
    version: string,
    token: string,
    extra: Record<string, unknown> = {},
    tarball: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3, 4]),
  ): Promise<Response> {
    const form = new FormData()
    form.set('metadata', JSON.stringify({ name, version, description: 'the platform kit', ...extra }))
    form.set('tarball', new File([tarball], `${name.replace('/', '-')}-${version}.tgz`))
    return fetch(`${baseUrl}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
  }

  function get(path: string, token?: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) }
    if (token) headers.Authorization = `Bearer ${token}`
    return fetch(`${baseUrl}${path}`, { ...init, headers })
  }

  function api(method: string, path: string, token: string | undefined, body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  async function mintPackageToken(name = PRIVATE, token = ownerToken, body: Record<string, unknown> = { name: 'client-ci' }): Promise<string> {
    const res = await api('POST', `/packages/${encodeURIComponent(name)}/tokens`, token, body)
    expect(res.status).toBe(201)
    return (await res.json() as any).token
  }

  /** The read surfaces, as (label, path) pairs for a package name. */
  function readSurfaces(name: string): Array<[string, string]> {
    const n = encodeURIComponent(name)
    return [
      ['metadata', `/packages/${n}`],
      ['raw scoped metadata', `/packages/${name}`],
      ['versions', `/packages/${n}/versions`],
      ['version', `/packages/${n}/1.0.0`],
      ['tarball', `/packages/${n}/1.0.0/tarball`],
      ['paywall', `/packages/${n}/paywall`],
      ['package page', `/package/${n}`],
      ['downloads badge', `/api/badge/downloads/${n}`],
      ['version badge', `/api/badge/version/${n}`],
      ['analytics', `/analytics/${n}`],
      ['analytics timeline', `/analytics/${n}/timeline?days=7`],
      ['requested versions', `/analytics/${n}/requested-versions`],
      ['commit snapshot', `/commits/abc1234abc1234abc1234abc1234abc1234abc12/${n}`],
      ['commit tarball', `/commits/abc1234abc1234abc1234abc1234abc1234abc12/${n}/tarball`],
    ]
  }

  /** What a caller gets, minus the parts that legitimately differ per name. */
  async function shape(res: Response, name: string): Promise<{ status: number, body: string }> {
    const text = await res.text()
    return {
      status: res.status,
      body: text
        .replaceAll(name, '<name>')
        .replaceAll(encodeURIComponent(name), '<name>')
        .replaceAll(escapeHtml(name), '<name>')
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>'),
    }
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  /** Assert every read surface answers `token` as if `PRIVATE` didn't exist. */
  async function expectInvisible(token?: string, headers: Record<string, string> = {}): Promise<void> {
    const hidden = readSurfaces(PRIVATE)
    const missing = readSurfaces(MISSING)
    for (let i = 0; i < hidden.length; i++) {
      const [label, path] = hidden[i]
      const a = await shape(await get(path, token, { headers }), PRIVATE)
      const b = await shape(await get(missing[i][1], token, { headers }), MISSING)
      expect({ label, ...a }).toEqual({ label, ...b })
      expect({ label, leaked: a.body.includes('the platform kit') }).toEqual({ label, leaked: false })
    }

    const search = await get('/search?q=platform&format=json', token, { headers })
    expect(((await search.json()) as any).results.map((r: any) => r.name)).not.toContain(PRIVATE)
    const top = await get('/analytics/top?limit=50', token, { headers })
    expect(((await top.json()) as any).packages.map((p: any) => p.name)).not.toContain(PRIVATE)
  }

  /** Assert `token` (or session cookie) can read the package and its tarball. */
  async function expectReadable(token?: string, headers: Record<string, string> = {}): Promise<void> {
    const meta = await get(`/packages/${ENCODED}`, token, { headers })
    expect(meta.status).toBe(200)
    expect(meta.headers.get('cache-control')).toBe('private, no-store')
    expect(((await meta.json()) as any).name).toBe(PRIVATE)

    const versions = await get(`/packages/${ENCODED}/versions`, token, { headers })
    expect(((await versions.json()) as any).versions).toContain('1.0.0')
    expect(versions.headers.get('cache-control')).toBe('private, no-store')

    const version = await get(`/packages/${ENCODED}/1.0.0`, token, { headers })
    expect(version.status).toBe(200)

    const tarball = await get(`/packages/${ENCODED}/1.0.0/tarball`, token, { headers })
    expect(tarball.status).toBe(200)
    expect(tarball.headers.get('cache-control')).toBe('private, no-store')
    expect(new Uint8Array(await tarball.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
  }

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
    process.env.PANTRY_REGISTRY_TOKEN = ADMIN_TOKEN
    delete process.env.PANTRY_TOKEN
    delete process.env.STRIPE_SECRET_KEY
    delete process.env.REGISTRY_VISIBILITY
    delete process.env.BASE_URL

    port = await getAvailablePort()
    baseUrl = `http://localhost:${port}`
    // No npm fallback: "doesn't exist" has to mean the same thing every run.
    registry = new Registry({ s3Bucket: 'local', dynamoTable: 'local', baseUrl, npmFallback: false })
    authStorage = new InMemoryAuthStorage()
    auth = new AuthService(authStorage)
    analytics = new InMemoryAnalytics()
    server = createServer(registry, port, analytics, undefined, undefined, undefined, authStorage)
    server.start()

    // HQ is on Team: private packages, and a teammate who ships releases.
    ownerToken = await account('owner@hq.training')
    ownerReadToken = (await auth.createApiToken('owner@hq.training', 'read-only', { permissions: ['read'] })).token
    await auth.setSubscription('owner@hq.training', { tier: 'team', status: 'active' })
    memberToken = await account('dev@hq.training')
    await auth.addTeamMember('owner@hq.training', 'dev@hq.training', 10)

    // An enterprise client, granted as a team: their seat holder gets the grant.
    clientToken = await account('it@client.example')
    await auth.setSubscription('it@client.example', { tier: 'team', status: 'active' })
    clientTeamMemberToken = await account('ci@client.example', ['read'])
    await auth.addTeamMember('it@client.example', 'ci@client.example', 10)

    strangerToken = await account('stranger@elsewhere.example')

    const res = await publish(PRIVATE, '1.0.0', ownerToken, { publishConfig: { access: 'restricted' } })
    expect(res.status).toBe(201)
    expect(((await res.json()) as any).visibility).toBe('private')
    await analytics.trackDownload({ packageName: PRIVATE, version: '1.0.0', timestamp: new Date().toISOString() })
    await registry.publishCommit(PRIVATE, 'abc1234abc1234abc1234abc1234abc1234abc12', new Uint8Array([9, 9]).buffer)
  })

  afterEach(async () => {
    await server.stop(true)
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  // -------------------------------------------------------------------------

  describe('publishing private', () => {
    it('stores the package as private from its first write', async () => {
      const record = await registry.getPublisherPackageRecord(PRIVATE)
      expect(record?.settings?.visibility).toBe('private')
      expect(record?.publishedBy).toBe('owner@hq.training')
    })

    it('honours publishConfig in the packaged manifest when the request metadata omits it', async () => {
      const bytes = tgz({ name: '@hq/kit', version: '1.0.0', publishConfig: { access: 'restricted' } })
      const res = await publish('@hq/kit', '1.0.0', ownerToken, {}, bytes)
      expect(res.status).toBe(201)
      expect(((await res.json()) as any).visibility).toBe('private')
      expect((await get(`/packages/${encodeURIComponent('@hq/kit')}`)).status).toBe(404)
    })

    it('refuses a restricted publish on a plan without private packages, publishing nothing', async () => {
      const res = await publish('@stranger/secret', '1.0.0', strangerToken, { publishConfig: { access: 'restricted' } })
      expect(res.status).toBe(402)
      expect(await registry.getPublisherPackageRecord('@stranger/secret')).toBeNull()
    })

    it('lets the operator publish private with the registry token', async () => {
      expect((await publish('@ops/internal', '1.0.0', ADMIN_TOKEN, { publishConfig: { access: 'restricted' } })).status).toBe(201)
      expect((await get(`/packages/${encodeURIComponent('@ops/internal')}`, strangerToken)).status).toBe(404)
      expect((await get(`/packages/${encodeURIComponent('@ops/internal')}`, ADMIN_TOKEN)).status).toBe(200)
    })

    it('keeps a private package private when a later publish says public', async () => {
      const res = await publish(PRIVATE, '1.1.0', ownerToken, { publishConfig: { access: 'public' } })
      expect(res.status).toBe(201)
      expect(((await res.json()) as any).visibility).toBe('private')
      expect((await registry.getPublisherPackageRecord(PRIVATE))?.settings?.visibility).toBe('private')
      expect((await get(`/packages/${ENCODED}/1.1.0`)).status).toBe(404)
    })

    it('keeps later publishes private when they say nothing at all', async () => {
      expect((await publish(PRIVATE, '1.2.0', memberToken)).status).toBe(201)
      expect((await get(`/packages/${ENCODED}`)).status).toBe(404)
    })

    it('does not make an existing public package private from a later publish', async () => {
      expect((await publish('@hq/open', '1.0.0', ownerToken)).status).toBe(201)
      const res = await publish('@hq/open', '1.1.0', ownerToken, { publishConfig: { access: 'restricted' } })
      expect(((await res.json()) as any).visibility).toBe('public')
      expect((await get(`/packages/${encodeURIComponent('@hq/open')}`)).status).toBe(200)
    })
  })

  // -------------------------------------------------------------------------

  describe('who cannot see it', () => {
    it('is indistinguishable from a missing package for anonymous callers', async () => {
      await expectInvisible()
    })

    it('is indistinguishable from a missing package for an ungranted account', async () => {
      await expectInvisible(strangerToken)
      await expectInvisible(undefined, { Cookie: `pantry_session=${await session('stranger@elsewhere.example')}` })
    })

    it('is invisible to a token scoped to a different package', async () => {
      expect((await publish('@hq/other', '1.0.0', ownerToken, { publishConfig: { access: 'restricted' } })).status).toBe(201)
      const otherToken = await mintPackageToken('@hq/other')
      expect((await get(`/packages/${encodeURIComponent('@hq/other')}`, otherToken)).status).toBe(200)
      await expectInvisible(otherToken)
    })

    it('stays off the public listings and pages for everyone, owner included', async () => {
      for (const token of [undefined, ownerToken]) {
        const html = await (await get('/search?q=platform', token, { headers: { Accept: 'text/html' } })).text()
        expect(html).not.toContain('the platform kit')
        const stats = await (await get('/stats', token)).text()
        expect(stats).not.toContain(PRIVATE)
        const home = await (await get('/', token, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text()
        expect(home).not.toContain(PRIVATE)
      }
    })

    it('treats an expired grant as no grant', async () => {
      await registry.metadata.putAccessGrant({
        packageName: PRIVATE,
        token: accountSubject('stranger@elsewhere.example'),
        grantedAt: new Date(Date.now() - 86_400_000).toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
      await expectInvisible(strangerToken)
    })

    it('treats an expired package token as no token', async () => {
      const token = await mintPackageToken()
      const record = await authStorage.getApiTokenByHash(hashToken(token))
      record!.expiresAt = new Date(Date.now() - 1000).toISOString()
      await expectInvisible(token)
    })

    it('hides a revoked package token and a revoked grant', async () => {
      const token = await mintPackageToken()
      const listed = await (await api('GET', `/packages/${ENCODED}/tokens`, ownerToken)).json() as any
      expect((await api('DELETE', `/packages/${ENCODED}/tokens/${encodeURIComponent(listed.tokens[0].id)}`, ownerToken)).status).toBe(200)
      await expectInvisible(token)

      await api('PUT', `/packages/${ENCODED}/access`, ownerToken, { email: 'stranger@elsewhere.example' })
      expect((await get(`/packages/${ENCODED}`, strangerToken)).status).toBe(200)
      const revoked = await api('DELETE', `/packages/${ENCODED}/access`, ownerToken, { email: 'stranger@elsewhere.example' })
      expect(await revoked.json()).toEqual({ revoked: true })
      await expectInvisible(strangerToken)
    })
  })

  // -------------------------------------------------------------------------

  describe('who can see it', () => {
    it('serves the owner, by token and by session', async () => {
      await expectReadable(ownerToken)
      await expectReadable(ownerReadToken)
      await expectReadable(undefined, { Cookie: `pantry_session=${await session('owner@hq.training')}` })
    })

    it('serves the owner\'s team', async () => {
      await expectReadable(memberToken)
    })

    it('serves admins: the registry token and an admin session', async () => {
      await expectReadable(ADMIN_TOKEN)
      await auth.upsertAdminUser('root@pantry.dev', 'Root', 'password123')
      await expectReadable(undefined, { Cookie: `pantry_session=${await session('root@pantry.dev')}` })
    })

    it('serves an account granted access', async () => {
      const res = await api('PUT', `/packages/${ENCODED}/access`, ownerToken, { email: 'Stranger@Elsewhere.example' })
      expect(res.status).toBe(200)
      expect(((await res.json()) as any).grant.subject).toBe('user:stranger@elsewhere.example')
      await expectReadable(strangerToken)
    })

    it('serves a whole team through a grant to its seat holder', async () => {
      await api('PUT', `/packages/${ENCODED}/access`, ownerToken, { email: 'it@client.example' })
      await expectReadable(clientToken)
      await expectReadable(clientTeamMemberToken)
    })

    it('serves a package-scoped token, on the raw and encoded name alike', async () => {
      const token = await mintPackageToken()
      expect(token).toStartWith('ptry_')
      await expectReadable(token)
      expect((await get(`/packages/${PRIVATE}/versions`, token)).status).toBe(200)
    })

    it('shows the package in JSON search to those who may read it, uncached', async () => {
      const res = await get('/search?q=platform&format=json', ownerToken)
      expect(((await res.json()) as any).results.map((r: any) => r.name)).toContain(PRIVATE)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
    })

    it('renders the package page for the owner without caching it for anyone else', async () => {
      const cookie = { Cookie: `pantry_session=${await session('owner@hq.training')}` }
      const page = await get(`/package/${ENCODED}`, undefined, { headers: cookie })
      expect(page.status).toBe(200)
      expect(page.headers.get('cache-control')).toBe('private, no-store')
      expect((await get(`/package/${ENCODED}`)).status).toBe(404)
    })

    it('lets a package token install a private package that also has a price', async () => {
      expect((await api('POST', `/packages/${ENCODED}/paywall`, ownerToken, { price: 900 })).status).toBe(200)
      const token = await mintPackageToken()
      expect((await get(`/packages/${ENCODED}/1.0.0/tarball`, token)).status).toBe(200)
      // A stranger still sees nothing at all — not a 402 naming the price.
      expect((await get(`/packages/${ENCODED}/1.0.0/tarball`, strangerToken)).status).toBe(404)
      expect(await (await get(`/packages/${ENCODED}/paywall`, strangerToken)).json()).toEqual({ enabled: false })
    })

    it('honours an unexpired grant with an expiry', async () => {
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
      const res = await api('PUT', `/packages/${ENCODED}/access`, ownerToken, { email: 'stranger@elsewhere.example', expiresAt })
      expect(((await res.json()) as any).grant.expiresAt).toBe(expiresAt)
      await expectReadable(strangerToken)
    })
  })

  // -------------------------------------------------------------------------

  describe('package tokens', () => {
    it('lists tokens without secrets, and shows them among the grants', async () => {
      const token = await mintPackageToken(PRIVATE, ownerToken, { name: 'client-ci', expiresInDays: 30 })
      await api('PUT', `/packages/${ENCODED}/access`, ownerToken, { email: 'it@client.example' })

      const tokens = await (await api('GET', `/packages/${ENCODED}/tokens`, ownerToken)).json() as any
      expect(tokens.tokens).toHaveLength(1)
      expect(tokens.tokens[0].name).toBe('client-ci')
      expect(typeof tokens.tokens[0].expiresAt).toBe('string')
      expect(JSON.stringify(tokens)).not.toContain(token)

      const access = await (await api('GET', `/packages/${ENCODED}/access`, ownerToken)).json() as any
      const subjects = access.grants.map((g: any) => g.subject)
      expect(subjects).toContain('user:it@client.example')
      expect(subjects).toContain(`token:${tokens.tokens[0].id}`)
      expect(access.grants.find((g: any) => g.subject === 'user:it@client.example')).toMatchObject({ email: 'it@client.example', name: 'it', expiresAt: null })
      expect(JSON.stringify(access)).not.toContain(token)
    })

    it('can read its package and nothing else', async () => {
      const token = await mintPackageToken()
      // Not another package's private metadata, not publishing, not account
      // routes, not paid features, not management of its own package.
      expect((await publish('@hq/other', '1.0.0', ownerToken, { publishConfig: { access: 'restricted' } })).status).toBe(201)
      expect((await get(`/packages/${encodeURIComponent('@hq/other')}`, token)).status).toBe(404)
      expect((await publish(PRIVATE, '9.9.9', token)).status).toBe(401)
      expect((await publish('@anyone/new', '1.0.0', token)).status).toBe(401)
      expect((await api('GET', `/packages/${ENCODED}/tokens`, token)).status).toBe(401)
      expect((await api('PUT', `/packages/${ENCODED}/access`, token, { email: 'x@y.example' })).status).toBe(401)
      expect((await api('POST', `/packages/${ENCODED}/paywall`, token, { price: 900 })).status).toBe(401)
      expect((await api('POST', `/packages/${ENCODED}/checkout`, token)).status).toBe(401)
      expect((await api('POST', '/api/rebuild', token, { domain: 'curl.se' })).status).toBe(401)
      expect((await api('GET', '/mirror', token)).status).toBe(401)
      expect((await validate(token, 'publish', PRIVATE)).valid).toBe(false)
      expect((await validate(token, 'read')).valid).toBe(false)
    })

    it('cannot be minted with wider rights through the auth service', async () => {
      await expect(auth.createApiToken('owner@hq.training', 'x', { permissions: ['publish', 'read'], packageScope: [PRIVATE] })).rejects.toThrow('read-only')
    })

    it('validates expiresInDays', async () => {
      expect((await api('POST', `/packages/${ENCODED}/tokens`, ownerToken, { name: 'x', expiresInDays: -1 })).status).toBe(400)
      expect((await api('POST', `/packages/${ENCODED}/tokens`, ownerToken, { name: 'x', expiresInDays: 'soon' })).status).toBe(400)
      expect((await api('POST', `/packages/${ENCODED}/tokens`, ownerToken, { name: '' })).status).toBe(400)
    })

    it('works on a registry that is private as a whole, for its own package only', async () => {
      process.env.REGISTRY_VISIBILITY = 'private'
      const token = await mintPackageToken()
      expect((await get(`/packages/${ENCODED}/1.0.0/tarball`, token)).status).toBe(200)
      expect((await get(`/packages/${ENCODED}/versions`, token)).status).toBe(200)
      expect((await get('/search?q=platform&format=json', token)).status).toBe(401)
      expect((await get(`/packages/${encodeURIComponent('@hq/anything')}`, token)).status).toBe(401)
      expect((await api('GET', `/packages/${ENCODED}/access`, token)).status).toBe(401)
    })

    function validate(token: string, permission: 'publish' | 'read', packageName?: string) {
      return auth.validateAccessToken(token, ADMIN_TOKEN, permission, { packageName })
    }
  })

  // -------------------------------------------------------------------------

  describe('managing access', () => {
    it('refuses anonymous callers and read-only tokens', async () => {
      expect((await api('GET', `/packages/${ENCODED}/access`, undefined)).status).toBe(401)
      expect((await api('GET', `/packages/${ENCODED}/access`, ownerReadToken)).status).toBe(401)
    })

    it('answers a stranger as if the private package did not exist', async () => {
      for (const [method, path, body] of [
        ['GET', `/packages/${ENCODED}/access`, undefined],
        ['PUT', `/packages/${ENCODED}/access`, { email: 'stranger@elsewhere.example' }],
        ['DELETE', `/packages/${ENCODED}/access`, { email: 'it@client.example' }],
        ['GET', `/packages/${ENCODED}/tokens`, undefined],
        ['POST', `/packages/${ENCODED}/tokens`, { name: 'mine' }],
        ['DELETE', `/packages/${ENCODED}/tokens/ptry_abc...wxyz`, undefined],
        ['POST', `/packages/${ENCODED}/paywall`, { price: 900 }],
      ] as const) {
        const hidden = await api(method, path, strangerToken, body)
        const missing = await api(method, path.replace(ENCODED, encodeURIComponent(MISSING)), strangerToken, body)
        expect({ path, method, status: hidden.status, body: await hidden.json() })
          .toEqual({ path, method, status: missing.status, body: await missing.json() })
        expect(hidden.status).toBe(404)
      }
    })

    it('forbids a granted reader who is not the owner', async () => {
      await api('PUT', `/packages/${ENCODED}/access`, ownerToken, { email: 'stranger@elsewhere.example' })
      expect((await api('GET', `/packages/${ENCODED}/access`, strangerToken)).status).toBe(403)
      expect((await api('PUT', `/packages/${ENCODED}/access`, strangerToken, { email: 'friend@elsewhere.example' })).status).toBe(403)
      expect((await api('POST', `/packages/${ENCODED}/tokens`, strangerToken, { name: 'mine' })).status).toBe(403)
    })

    it('forbids a non-owner on a public package', async () => {
      expect((await publish('@hq/open', '1.0.0', ownerToken)).status).toBe(201)
      expect((await api('GET', `/packages/${encodeURIComponent('@hq/open')}/access`, strangerToken)).status).toBe(403)
    })

    it('lets team members, admins and admin sessions manage access', async () => {
      expect((await api('PUT', `/packages/${ENCODED}/access`, memberToken, { email: 'a@client.example' })).status).toBe(200)
      expect((await api('PUT', `/packages/${ENCODED}/access`, ADMIN_TOKEN, { email: 'b@client.example' })).status).toBe(200)
      await auth.upsertAdminUser('root@pantry.dev', 'Root', 'password123')
      const res = await fetch(`${baseUrl}/packages/${ENCODED}/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': `pantry_session=${await session('root@pantry.dev')}` },
        body: JSON.stringify({ name: 'ops' }),
      })
      expect(res.status).toBe(201)
    })

    it('lets an owner session manage access too', async () => {
      const res = await fetch(`${baseUrl}/packages/${ENCODED}/access`, {
        headers: { Cookie: `pantry_session=${await session('owner@hq.training')}` },
      })
      expect(res.status).toBe(200)
    })

    it('validates grants', async () => {
      expect((await api('PUT', `/packages/${ENCODED}/access`, ownerToken, { email: 'not-an-email' })).status).toBe(400)
      expect((await api('PUT', `/packages/${ENCODED}/access`, ownerToken, { email: 'a@b.example', expiresAt: 'tomorrow' })).status).toBe(400)
      expect((await api('PUT', `/packages/${ENCODED}/access`, ownerToken, { email: 'a@b.example', expiresAt: '2001-01-01T00:00:00Z' })).status).toBe(400)
      expect((await api('DELETE', `/packages/${ENCODED}/access`, ownerToken, { email: 'nobody@b.example' })).status).toBe(404)
    })

    it('keeps the original grant date when an expiry changes', async () => {
      const first = await (await api('PUT', `/packages/${ENCODED}/access`, ownerToken, { email: 'it@client.example' })).json() as any
      const later = new Date(Date.now() + 7 * 86_400_000).toISOString()
      const second = await (await api('PUT', `/packages/${ENCODED}/access`, ownerToken, { email: 'it@client.example', expiresAt: later })).json() as any
      expect(second.grant.createdAt).toBe(first.grant.createdAt)
      expect(second.grant.expiresAt).toBe(later)
      const cleared = await (await api('PUT', `/packages/${ENCODED}/access`, ownerToken, { email: 'it@client.example', expiresAt: null })).json() as any
      expect(cleared.grant.expiresAt).toBeNull()
    })
  })

  // -------------------------------------------------------------------------

  describe('settings', () => {
    async function patch(name: string, email: string, settings: Record<string, unknown>): Promise<Response> {
      return fetch(`${baseUrl}/publisher/api/packages/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Cookie': `pantry_session=${await session(email)}` },
        body: JSON.stringify({ settings }),
      })
    }

    it('lets an entitled owner make a public package private, and back', async () => {
      expect((await publish('@hq/open', '1.0.0', ownerToken)).status).toBe(201)
      expect((await patch('@hq/open', 'owner@hq.training', { visibility: 'private' })).status).toBe(200)
      expect((await get(`/packages/${encodeURIComponent('@hq/open')}`)).status).toBe(404)
      expect((await patch('@hq/open', 'owner@hq.training', { visibility: 'public' })).status).toBe(200)
      expect((await get(`/packages/${encodeURIComponent('@hq/open')}`)).status).toBe(200)
    })

    it('makes private a paid-plan feature and rejects unknown visibilities', async () => {
      expect((await publish('stranger-lib', '1.0.0', strangerToken)).status).toBe(201)
      expect((await patch('stranger-lib', 'stranger@elsewhere.example', { visibility: 'private' })).status).toBe(402)
      expect((await patch('stranger-lib', 'stranger@elsewhere.example', { visibility: 'secret' })).status).toBe(400)
      expect((await get('/packages/stranger-lib')).status).toBe(200)
    })

    it('does not let a stranger claim an unowned private package through the dashboard', async () => {
      expect((await publish('@ops/internal', '1.0.0', ADMIN_TOKEN, { publishConfig: { access: 'restricted' } })).status).toBe(201)
      expect((await patch('@ops/internal', 'stranger@elsewhere.example', { description: 'mine now' })).status).toBe(403)
      expect((await registry.getPublisherPackageRecord('@ops/internal'))?.publishedBy).toBeUndefined()
    })
  })
})

describe('private package rules', () => {
  it('reads publishConfig.access from metadata or the packaged manifest', () => {
    expect(restrictedAccessRequested({ publishConfig: { access: 'restricted' } })).toBe(true)
    expect(restrictedAccessRequested({ publishConfig: { access: 'public' } })).toBe(false)
    expect(restrictedAccessRequested({}, tgz({ publishConfig: { access: 'Restricted' } }).buffer)).toBe(true)
    expect(restrictedAccessRequested({}, new Uint8Array([1, 2, 3]).buffer)).toBe(false)
  })

  it('parses grant expiries', () => {
    expect(parseGrantExpiry(undefined)).toEqual({ expiresAt: null })
    expect(parseGrantExpiry(null)).toEqual({ expiresAt: null })
    expect('error' in parseGrantExpiry('2001-01-01')).toBe(true)
    expect('error' in parseGrantExpiry(42)).toBe(true)
  })

  it('only ever refuses private packages', async () => {
    const storage = new InMemoryMetadataStorage()
    const reader = { admin: false }
    expect(await canReadPackage(storage, { name: 'a', settings: { visibility: 'unlisted' } }, reader)).toBe(true)
    expect(await canReadPackage(storage, { name: 'a' }, reader)).toBe(true)
    expect(await canReadPackage(storage, { name: 'a', settings: { visibility: 'private' } }, reader)).toBe(false)
    expect(await canReadPackage(storage, { name: 'a', settings: { visibility: 'private' } }, { admin: true })).toBe(true)
  })
})

/** A single-table DynamoDB stand-in: enough of getItem/putItem/query/scan/deleteItem. */
function fakeDynamo(): any {
  const rows = new Map<string, any>()
  const key = (k: any) => `${k.PK.S}|${k.SK.S}`
  return {
    rows,
    async getItem({ Key }: any) { return { Item: rows.get(key(Key)) } },
    async putItem({ Item, ConditionExpression }: any) {
      if (ConditionExpression === 'attribute_not_exists(PK)' && rows.has(key(Item)))
        throw Object.assign(new Error('exists'), { awsType: 'ConditionalCheckFailedException' })
      rows.set(key(Item), Item)
    },
    async updateItem() {},
    async deleteItem({ Key }: any) { rows.delete(key(Key)) },
    async query({ ExpressionAttributeValues: v }: any) {
      return { Items: [...rows.values()].filter(r => r.PK.S === v[':pk'].S && r.SK.S.startsWith(v[':prefix'].S)) }
    },
    async scan() { return { Items: [...rows.values()].filter(r => r.SK.S === 'METADATA') } },
  }
}

describe('private packages on the DynamoDB backends', () => {
  it('stores visibility with the first write and reads it back as an object', async () => {
    const store = new DynamoDBMetadataStorage('test', 'us-east-1')
    ;(store as any).db = fakeDynamo()
    await store.putVersion(PRIVATE, '1.0.0', { name: PRIVATE, version: '1.0.0', publishedAt: new Date().toISOString(), description: 'kit' }, {
      ifAbsent: true,
      settingsIfNew: { visibility: 'private' },
    })
    expect((await store.getPackage(PRIVATE))?.settings?.visibility).toBe('private')
    expect((await store.search('kit'))[0]?.private).toBe(true)
  })

  it('lists and deletes access grants', async () => {
    const store = new DynamoDBMetadataStorage('test', 'us-east-1')
    ;(store as any).db = fakeDynamo()
    await store.putAccessGrant({ packageName: PRIVATE, token: accountSubject('a@b.example'), grantedAt: new Date().toISOString(), grantedBy: 'owner@hq.training' })
    expect((await store.listAccessGrants(PRIVATE)).map(g => [g.token, g.grantedBy])).toEqual([['user:a@b.example', 'owner@hq.training']])
    await store.deleteAccessGrant(PRIVATE, accountSubject('a@b.example'))
    expect(await store.listAccessGrants(PRIVATE)).toEqual([])
  })

  it('keeps a token\'s package scope through storage', async () => {
    const storage = new DynamoDBAuthStorage('test', 'us-east-1')
    ;(storage as any).db = fakeDynamo()
    const auth = new AuthService(storage)
    const { token } = await auth.createPackageToken(PRIVATE, 'ci', { createdBy: 'owner@hq.training' })
    expect((await storage.getApiTokenByHash(hashToken(token)))?.packageScope).toEqual([PRIVATE])
    expect((await auth.listPackageTokens(PRIVATE))[0]?.packageScope).toEqual([PRIVATE])
    expect((await auth.validateAccessToken(token, '', 'read', { packageName: PRIVATE })).valid).toBe(true)
    expect((await auth.validateAccessToken(token, '', 'read')).valid).toBe(false)
  })
})
