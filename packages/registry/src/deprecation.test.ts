/**
 * Package deprecation, end to end against a running server.
 *
 * An owner retires a package with `PUT /packages/{name}/deprecation` (what
 * `pantry deprecate` sends) or from the publisher dashboard. Every metadata
 * document a client reads then carries npm's `deprecated: "<message>"`, the
 * package page and the storefront say "Deprecated", and nothing else about the
 * package changes - its versions still install and a private package stays
 * private.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createServer } from './server'
import { Registry } from './registry'
import { AuthService, InMemoryAuthStorage } from './auth'
import { InMemoryAnalytics } from './analytics'
import {
  DEFAULT_DEPRECATION_MESSAGE,
  MAX_DEPRECATION_MESSAGE_LENGTH,
  deprecationMessage,
  parseDeprecationMessage,
  withDeprecation,
} from './deprecation'
import { getAvailablePort } from './test-utils'

const ADMIN_TOKEN = 'ptry_admin_token_for_deprecation_tests'
const PROBE = '@hq/kit-probe'
const PRIVATE = '@hq/platform'
const MESSAGE = 'Empty test package; nothing to install here.'

/** Every spelling a scoped name reaches the registry in. */
const SPELLINGS = [
  PROBE, // raw: @hq/kit-probe
  '@hq%2Fkit-probe', // what the CLI sends
  '@hq%2fkit-probe', // lowercase escape
  '%40hq%2Fkit-probe', // encodeURIComponent
  '%40hq%2fkit-probe',
]

describe('deprecation helpers', () => {
  it('derives the message from settings, never empty', () => {
    expect(deprecationMessage(undefined)).toBeNull()
    expect(deprecationMessage({ deprecated: false, deprecationMessage: 'x' })).toBeNull()
    expect(deprecationMessage({ deprecated: true })).toBe(DEFAULT_DEPRECATION_MESSAGE)
    expect(deprecationMessage({ deprecated: true, deprecationMessage: '   ' })).toBe(DEFAULT_DEPRECATION_MESSAGE)
    expect(deprecationMessage({ deprecated: true, deprecationMessage: 'use\n@hq/kit\tinstead' })).toBe('use @hq/kit instead')
  })

  it('marks a document only when deprecated', () => {
    const doc = { name: 'x', version: '1.0.0' }
    expect(withDeprecation(doc, undefined)).toBe(doc)
    expect(withDeprecation(doc, { deprecated: true, deprecationMessage: 'gone' })).toEqual({ ...doc, deprecated: 'gone' })
    expect(doc).toEqual({ name: 'x', version: '1.0.0' })
  })

  it('validates request messages', () => {
    expect(parseDeprecationMessage(undefined)).toEqual({ message: undefined })
    expect(parseDeprecationMessage(null)).toEqual({ message: undefined })
    expect(parseDeprecationMessage('  ')).toEqual({ message: undefined })
    expect(parseDeprecationMessage('line one\r\nline two')).toEqual({ message: 'line one line two' })
    expect(parseDeprecationMessage(42)).toEqual({ error: 'message must be a string' })
    expect('error' in parseDeprecationMessage('x'.repeat(MAX_DEPRECATION_MESSAGE_LENGTH + 1))).toBe(true)
  })
})

describe('package deprecation', () => {
  let port: number
  let baseUrl: string
  let server: ReturnType<typeof createServer>
  let registry: Registry
  let auth: AuthService
  let authStorage: InMemoryAuthStorage
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = ['PANTRY_REGISTRY_TOKEN', 'PANTRY_TOKEN', 'STRIPE_SECRET_KEY', 'REGISTRY_VISIBILITY', 'BASE_URL']

  let ownerToken: string
  let ownerReadToken: string
  let memberToken: string
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

  async function publish(name: string, version: string, token: string, extra: Record<string, unknown> = {}): Promise<void> {
    const form = new FormData()
    form.set('metadata', JSON.stringify({ name, version, description: 'a probe', ...extra }))
    form.set('tarball', new File([new Uint8Array([1, 2, 3, 4])], `${name.replace('/', '-')}-${version}.tgz`))
    const res = await fetch(`${baseUrl}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
    expect(res.status).toBe(201)
  }

  function api(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  async function metadata(path: string, token?: string): Promise<any> {
    const res = await api('GET', path, token)
    expect(res.status).toBe(200)
    return res.json()
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
    registry = new Registry({ s3Bucket: 'local', dynamoTable: 'local', baseUrl, npmFallback: false })
    authStorage = new InMemoryAuthStorage()
    auth = new AuthService(authStorage)
    server = createServer(registry, port, new InMemoryAnalytics(), undefined, undefined, undefined, authStorage)
    server.start()

    ownerToken = await account('owner@hq.training')
    ownerReadToken = (await auth.createApiToken('owner@hq.training', 'read-only', { permissions: ['read'] })).token
    await auth.setSubscription('owner@hq.training', { tier: 'team', status: 'active' })
    memberToken = await account('dev@hq.training')
    await auth.addTeamMember('owner@hq.training', 'dev@hq.training', 10)
    strangerToken = await account('stranger@elsewhere.example')

    await publish(PROBE, '1.0.0', ownerToken)
    await publish(PROBE, '1.1.0', ownerToken)
    await publish(PRIVATE, '1.0.0', ownerToken, { publishConfig: { access: 'restricted' } })
  })

  afterEach(async () => {
    await server.stop(true)
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it('marks every version\'s metadata with npm\'s deprecated field', async () => {
    expect((await metadata(`/packages/${encodeURIComponent(PROBE)}`)).deprecated).toBeUndefined()

    const res = await api('PUT', `/packages/@hq%2Fkit-probe/deprecation`, ownerToken, { message: MESSAGE })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ name: PROBE, deprecated: true, message: MESSAGE })

    for (const spelling of SPELLINGS) {
      expect({ spelling, ...(await metadata(`/packages/${spelling}`)) }).toMatchObject({ spelling, name: PROBE, version: '1.1.0', deprecated: MESSAGE })
      expect({ spelling, ...(await metadata(`/packages/${spelling}/1.0.0`)) }).toMatchObject({ spelling, version: '1.0.0', deprecated: MESSAGE })
    }

    // Still installable: deprecation retires a package, it doesn't remove it.
    const versions = await metadata(`/packages/${encodeURIComponent(PROBE)}/versions`)
    expect(versions.versions.sort()).toEqual(['1.0.0', '1.1.0'])
    const tarball = await api('GET', `/packages/${encodeURIComponent(PROBE)}/1.0.0/tarball`)
    expect(tarball.status).toBe(200)

    // The deprecation is derived when served, never written into a version.
    const stored = await registry.metadata.getPackageVersion(PROBE, '1.0.0')
    expect((stored as any).deprecated).toBeUndefined()
  })

  it('accepts every spelling of a scoped name on the deprecation route', async () => {
    for (const spelling of SPELLINGS) {
      const res = await api('PUT', `/packages/${spelling}/deprecation`, ownerToken, { message: `via ${spelling}` })
      expect({ spelling, status: res.status }).toEqual({ spelling, status: 200 })
      expect((await metadata(`/packages/${encodeURIComponent(PROBE)}/1.0.0`)).deprecated).toBe(`via ${spelling}`)

      const undo = await api('DELETE', `/packages/${spelling}/deprecation`, ownerToken)
      expect({ spelling, status: undo.status }).toEqual({ spelling, status: 200 })
      expect((await metadata(`/packages/${encodeURIComponent(PROBE)}/1.0.0`)).deprecated).toBeUndefined()
    }
  })

  it('uses a default message when none is given, with or without a body', async () => {
    expect((await api('PUT', `/packages/@hq%2Fkit-probe/deprecation`, ownerToken)).status).toBe(200)
    expect((await metadata(`/packages/@hq%2Fkit-probe`)).deprecated).toBe(DEFAULT_DEPRECATION_MESSAGE)
    expect((await api('POST', `/packages/@hq%2Fkit-probe/deprecation`, ownerToken, { message: ' ' })).status).toBe(200)
    expect((await metadata(`/packages/@hq%2Fkit-probe`)).deprecated).toBe(DEFAULT_DEPRECATION_MESSAGE)
  })

  it('undeprecates with DELETE', async () => {
    await api('PUT', `/packages/@hq%2Fkit-probe/deprecation`, ownerToken, { message: MESSAGE })
    const res = await api('DELETE', `/packages/@hq%2Fkit-probe/deprecation`, ownerToken)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: PROBE, deprecated: false })
    expect((await metadata(`/packages/@hq%2Fkit-probe`)).deprecated).toBeUndefined()
    expect((await registry.getPublisherPackageRecord(PROBE))?.settings?.deprecated).toBe(false)
  })

  it('rejects bad messages', async () => {
    expect((await api('PUT', `/packages/@hq%2Fkit-probe/deprecation`, ownerToken, { message: 7 })).status).toBe(400)
    expect((await api('PUT', `/packages/@hq%2Fkit-probe/deprecation`, ownerToken, { message: 'x'.repeat(MAX_DEPRECATION_MESSAGE_LENGTH + 1) })).status).toBe(400)
    const broken = await fetch(`${baseUrl}/packages/@hq%2Fkit-probe/deprecation`, { method: 'PUT', headers: { Authorization: `Bearer ${ownerToken}` }, body: '{nope' })
    expect(broken.status).toBe(400)
    expect((await metadata(`/packages/@hq%2Fkit-probe`)).deprecated).toBeUndefined()
  })

  it('lets the owner\'s team, admins and an owner session deprecate', async () => {
    expect((await api('PUT', `/packages/@hq%2Fkit-probe/deprecation`, memberToken, { message: 'team' })).status).toBe(200)
    expect((await metadata(`/packages/@hq%2Fkit-probe`)).deprecated).toBe('team')
    // Still the seat holder's package.
    expect((await registry.getPublisherPackageRecord(PROBE))?.publishedBy).toBe('owner@hq.training')

    expect((await api('PUT', `/packages/@hq%2Fkit-probe/deprecation`, ADMIN_TOKEN, { message: 'admin' })).status).toBe(200)
    expect((await metadata(`/packages/@hq%2Fkit-probe`)).deprecated).toBe('admin')

    const cookie = { Cookie: `pantry_session=${await session('owner@hq.training')}` }
    expect((await api('PUT', `/packages/@hq%2Fkit-probe/deprecation`, undefined, { message: 'session' }, cookie)).status).toBe(200)
    expect((await metadata(`/packages/@hq%2Fkit-probe`)).deprecated).toBe('session')
  })

  it('refuses everyone else, changing nothing', async () => {
    expect((await api('PUT', `/packages/@hq%2Fkit-probe/deprecation`, undefined, { message: 'x' })).status).toBe(401)
    // A read-only token is not authority over a package, even the owner's.
    expect((await api('PUT', `/packages/@hq%2Fkit-probe/deprecation`, ownerReadToken, { message: 'x' })).status).toBe(401)
    const stranger = await api('PUT', `/packages/@hq%2Fkit-probe/deprecation`, strangerToken, { message: 'x' })
    expect(stranger.status).toBe(403)
    expect(((await stranger.json()) as any).error).toContain('Only the publisher')
    expect((await api('DELETE', `/packages/@hq%2Fkit-probe/deprecation`, strangerToken)).status).toBe(403)
    // A private package a stranger can't see doesn't admit to existing.
    expect((await api('PUT', `/packages/@hq%2Fplatform/deprecation`, strangerToken, { message: 'x' })).status).toBe(404)
    expect((await api('PUT', `/packages/@hq%2Fnever-published/deprecation`, ownerToken, { message: 'x' })).status).toBe(404)
    expect((await metadata(`/packages/@hq%2Fkit-probe`)).deprecated).toBeUndefined()
  })

  it('keeps a private package private, and readable by those it was', async () => {
    const res = await api('PUT', `/packages/${PRIVATE}/deprecation`, ownerToken, { message: MESSAGE })
    expect(res.status).toBe(200)
    const record = await registry.getPublisherPackageRecord(PRIVATE)
    expect(record?.settings).toMatchObject({ visibility: 'private', deprecated: true, deprecationMessage: MESSAGE })

    expect((await metadata(`/packages/@hq%2Fplatform/1.0.0`, ownerToken)).deprecated).toBe(MESSAGE)
    expect((await api('GET', `/packages/@hq%2Fplatform/1.0.0`, strangerToken)).status).toBe(404)
    expect((await api('GET', `/packages/@hq%2Fplatform`)).status).toBe(404)
  })

  it('merges a dashboard PATCH into the existing settings', async () => {
    const cookie = { Cookie: `pantry_session=${await session('owner@hq.training')}` }
    const res = await api('PATCH', `/publisher/api/packages/${encodeURIComponent(PRIVATE)}`, undefined, {
      settings: { deprecated: true, deprecationMessage: 'from\nthe dashboard' },
    }, cookie)
    expect(res.status).toBe(200)
    const record = await registry.getPublisherPackageRecord(PRIVATE)
    expect(record?.settings).toMatchObject({ visibility: 'private', deprecated: true, deprecationMessage: 'from the dashboard' })
    expect((await metadata(`/packages/@hq%2Fplatform`, ownerToken)).deprecated).toBe('from the dashboard')

    const bad = await api('PATCH', `/publisher/api/packages/${encodeURIComponent(PRIVATE)}`, undefined, { settings: { deprecated: 'yes' } }, cookie)
    expect(bad.status).toBe(400)
  })

  it('shows a Deprecated notice on the package page, gone again after undo', async () => {
    const page = async () => (await api('GET', `/package/${encodeURIComponent(PROBE)}`)).text()
    expect(await page()).not.toContain('data-deprecated')

    await api('PUT', `/packages/@hq%2Fkit-probe/deprecation`, ownerToken, { message: 'Use <b>@hq/kit</b> instead' })
    // The cached public page is dropped, so the notice shows immediately.
    const html = await page()
    expect(html).toContain('data-deprecated')
    expect(html).toContain('Deprecated')
    expect(html).toContain('Use &lt;b&gt;@hq/kit&lt;/b&gt; instead')
    expect(html).not.toContain('<b>@hq/kit</b>')

    await api('DELETE', `/packages/@hq%2Fkit-probe/deprecation`, ownerToken)
    expect(await page()).not.toContain('data-deprecated')
  })

  it('shows the notice on the storefront of a private package for sale', async () => {
    expect((await api('POST', `/packages/@hq%2Fplatform/paywall`, ownerToken, { price: 900 })).status).toBe(200)
    await api('PUT', `/packages/@hq%2Fplatform/deprecation`, ownerToken, { message: MESSAGE })

    const res = await api('GET', `/package/${encodeURIComponent(PRIVATE)}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('for sale')
    expect(html).toContain('data-deprecated')
    expect(html).toContain(MESSAGE)

    // And on the 402 a non-buyer's install gets, next to the listing.
    const denied = await api('GET', `/packages/@hq%2Fplatform/1.0.0`)
    expect(denied.status).toBe(402)
    expect(((await denied.json()) as any).deprecated).toBe(MESSAGE)
  })
})
