/**
 * Build insurance, security alerts, SBOM export and team-wide entitlements —
 * the four things a paid plan buys a *consumer* of the registry.
 *
 * Neither S3 nor OSV is touched: the mirror runs against an in-memory tarball
 * store with an injected fetcher, and the advisory source is injected too. The
 * point is to test our logic, not their uptime.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createServer, setEnterpriseStores } from './server'
import { createLocalRegistry } from './registry'
import { AuthService, InMemoryAuthStorage } from './auth'
import { MirrorStore, normalizeEntries, orgKey, type MirrorEntry } from './mirror'
import { checkLicense, osvEcosystem, SecurityStore, severityOf, type AdvisoryFetcher } from './security'
import { buildSbom, purlFor, toCycloneDx, toSpdx } from './sbom'
import type { TarballStorage } from './types'
import { getAvailablePort } from './test-utils'

const ADMIN_TOKEN = 'ptry_admin_token_for_enterprise_tests'

/** An object store that lives in a Map. */
class MemoryTarballStorage implements TarballStorage {
  objects = new Map<string, ArrayBuffer>()

  async upload(key: string, data: ArrayBuffer): Promise<string> {
    this.objects.set(key, data)
    return `memory://${key}`
  }

  async download(key: string): Promise<ArrayBuffer> {
    const found = this.objects.get(key)
    if (!found) throw new Error(`No such object: ${key}`)
    return found
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key)
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  getUrl(key: string): string {
    return `memory://${key}`
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter(k => k.startsWith(prefix))
  }
}

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('build insurance (the mirror)', () => {
  let storage: MemoryTarballStorage
  let upstream: Map<string, string>
  let mirror: MirrorStore
  let fetches: string[]

  beforeEach(() => {
    storage = new MemoryTarballStorage()
    upstream = new Map([
      ['https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', 'left-pad bytes'],
      ['https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', 'lodash bytes'],
    ])
    fetches = []
    mirror = new MirrorStore(storage, {
      fetcher: async (url) => {
        fetches.push(url)
        const found = upstream.get(url)
        if (!found) throw new Error('404 gone from upstream')
        return bytesOf(found)
      },
    })
  })

  const entry = (name: string, version: string, url: string): MirrorEntry =>
    ({ name, version, resolved: url, ecosystem: 'npm' })

  it('stores what an org installed, in the org\'s own namespace', async () => {
    const result = await mirror.snapshot('acme@example.com', [
      entry('left-pad', '1.3.0', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'),
      entry('lodash', '4.17.21', 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'),
    ])

    expect(result.mirrored).toBe(2)
    expect(result.failed).toBe(0)
    expect([...storage.objects.keys()].every(k => k.startsWith(`mirror/${orgKey('acme@example.com')}/`))).toBe(true)
  })

  it('serves the copy after upstream deletes it — the whole point', async () => {
    await mirror.snapshot('acme@example.com', [
      entry('left-pad', '1.3.0', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'),
    ])

    // The unpublish heard around the world.
    upstream.clear()

    const found = await mirror.fetchArtifact('acme@example.com', 'left-pad', '1.3.0')
    expect(found).not.toBeNull()
    expect(new TextDecoder().decode(found!.bytes)).toBe('left-pad bytes')
  })

  it('does not re-fetch what it already has', async () => {
    const one = [entry('left-pad', '1.3.0', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz')]
    await mirror.snapshot('acme@example.com', one)
    const second = await mirror.snapshot('acme@example.com', one)

    expect(second.skipped).toBe(1)
    expect(second.mirrored).toBe(0)
    expect(fetches.length).toBe(1)
  })

  it('treats a retagged version as new rather than trusting the name', async () => {
    const original = { ...entry('sneaky', '1.0.0', 'https://upstream/sneaky-1.0.0.tgz'), integrity: 'sha512-originalBytes' }
    upstream.set('https://upstream/sneaky-1.0.0.tgz', 'honest bytes')
    await mirror.snapshot('acme@example.com', [original])

    // Same version, different bytes and a different integrity: a retag.
    upstream.set('https://upstream/sneaky-1.0.0.tgz', 'swapped bytes')
    const retagged = { ...original, integrity: 'sha512-swappedBytes' }
    const result = await mirror.snapshot('acme@example.com', [retagged])

    expect(result.skipped).toBe(0)
    expect(result.mirrored).toBe(1)

    // Both copies are kept; the newest wins, and the original is still there.
    const stored = (await mirror.list('acme@example.com')).filter(e => e.name === 'sneaky')
    expect(stored.length).toBe(2)
  })

  it('refuses bytes that do not match the lockfile\'s integrity', async () => {
    // sha256 of "honest bytes", base64 — the lockfile's claim.
    const digest = await crypto.subtle.digest('SHA-256', bytesOf('honest bytes'))
    const correct = Buffer.from(new Uint8Array(digest)).toString('base64')

    upstream.set('https://upstream/tampered-1.0.0.tgz', 'malicious bytes')
    const result = await mirror.snapshot('acme@example.com', [{
      name: 'tampered',
      version: '1.0.0',
      resolved: 'https://upstream/tampered-1.0.0.tgz',
      integrity: `sha256-${correct}`,
    }])

    expect(result.mirrored).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.entries[0].error).toContain('integrity mismatch')
    expect(await mirror.fetchArtifact('acme@example.com', 'tampered', '1.0.0')).toBeNull()
  })

  it('records a failure instead of losing the whole snapshot', async () => {
    const result = await mirror.snapshot('acme@example.com', [
      entry('left-pad', '1.3.0', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'),
      entry('vanished', '9.9.9', 'https://registry.npmjs.org/vanished.tgz'),
    ])

    expect(result.mirrored).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.entries.find(e => e.name === 'vanished')?.error).toContain('404')
  })

  it('keeps orgs apart', async () => {
    await mirror.snapshot('acme@example.com', [entry('left-pad', '1.3.0', 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz')])
    expect(await mirror.fetchArtifact('other@example.com', 'left-pad', '1.3.0')).toBeNull()
  })

  it('refuses entries that would escape the org\'s prefix', async () => {
    const result = await mirror.snapshot('acme@example.com', [
      { name: '../../etc/passwd', version: '1.0.0', resolved: 'https://upstream/x' },
      { name: 'ok', version: '../../..', resolved: 'https://upstream/x' },
    ])
    expect(result.mirrored).toBe(0)
    expect(result.failed).toBe(2)
  })

  it('drops malformed entries from a client payload', () => {
    expect(normalizeEntries([
      { name: 'good', version: '1.0.0' },
      { name: 'no-version' },
      'nonsense',
      null,
    ])).toEqual([{ name: 'good', version: '1.0.0', resolved: undefined, integrity: undefined, ecosystem: undefined, license: undefined }])
  })
})

describe('security alerts', () => {
  let storage: MemoryTarballStorage

  const watched: MirrorEntry[] = [
    { name: 'left-pad', version: '1.3.0', ecosystem: 'npm', license: 'MIT' },
    { name: 'copyleft-thing', version: '2.0.0', ecosystem: 'npm', license: 'AGPL-3.0' },
  ]

  const advisories: AdvisoryFetcher = async entries => new Map(
    entries
      .filter(e => e.name === 'left-pad')
      .map(e => [`${e.name}@${e.version}`, [{
        type: 'vulnerability' as const,
        package: e.name,
        version: e.version,
        ecosystem: 'npm',
        id: 'GHSA-test-1234',
        severity: 'high' as const,
        summary: 'A problem',
        fixedIn: '1.3.1',
      }]]),
  )

  beforeEach(() => {
    storage = new MemoryTarballStorage()
  })

  it('reports advisories for what an org watches', async () => {
    const store = new SecurityStore(storage, advisories)
    await store.setWatchList('acme@example.com', watched)

    const report = await store.report('acme@example.com')
    expect(report.watched).toBe(2)
    expect(report.counts.high).toBe(1)
    const vuln = report.alerts.find(a => a.type === 'vulnerability')
    expect(vuln).toMatchObject({ package: 'left-pad', id: 'GHSA-test-1234', fixedIn: '1.3.1' })
  })

  it('says so when it could not check, rather than reporting all-clear', async () => {
    const store = new SecurityStore(storage, async () => { throw new Error('OSV unreachable') })
    await store.setWatchList('acme@example.com', watched)

    const report = await store.report('acme@example.com')
    expect(report.degraded).toContain('OSV unreachable')
    expect(report.alerts.filter(a => a.type === 'vulnerability')).toHaveLength(0)
  })

  it('enforces a licence deny-list', async () => {
    const store = new SecurityStore(storage, async () => new Map())
    await store.setWatchList('acme@example.com', watched, { deny: ['AGPL-3.0'] })

    const report = await store.report('acme@example.com')
    expect(report.counts.license).toBe(1)
    expect(report.alerts[0]).toMatchObject({ type: 'license', package: 'copyleft-thing', reason: 'denied' })
  })

  it('enforces an allow-list, including unknown licences', async () => {
    const store = new SecurityStore(storage, async () => new Map())
    await store.setWatchList('acme@example.com', [
      ...watched,
      { name: 'mystery', version: '1.0.0', ecosystem: 'npm' },
    ], { allow: ['MIT', 'Apache-2.0'] })

    const report = await store.report('acme@example.com')
    const flagged = report.alerts.filter(a => a.type === 'license').map(a => a.package)
    expect(flagged).toContain('copyleft-thing')
    expect(flagged).toContain('mystery')
    expect(flagged).not.toContain('left-pad')
  })

  it('does not wipe the policy when CI re-registers a lockfile', async () => {
    const store = new SecurityStore(storage, async () => new Map())
    await store.setWatchList('acme@example.com', watched, { deny: ['AGPL-3.0'] })
    await store.setWatchList('acme@example.com', watched) // a later CI run

    expect((await store.getWatchList('acme@example.com')).policy).toEqual({ deny: ['AGPL-3.0'] })
  })

  it('sorts the worst thing first', async () => {
    const mixed: AdvisoryFetcher = async () => new Map([
      ['a@1', [
        { type: 'vulnerability' as const, package: 'a', version: '1', ecosystem: 'npm', id: 'LOW', severity: 'low' as const, summary: '' },
        { type: 'vulnerability' as const, package: 'a', version: '1', ecosystem: 'npm', id: 'CRIT', severity: 'critical' as const, summary: '' },
      ]],
    ])
    const store = new SecurityStore(storage, mixed)
    await store.setWatchList('acme@example.com', [{ name: 'a', version: '1' }])

    const report = await store.report('acme@example.com')
    expect((report.alerts[0] as any).id).toBe('CRIT')
  })

  it('maps ecosystems OSV knows, and skips ones it does not', () => {
    expect(osvEcosystem('npm')).toBe('npm')
    expect(osvEcosystem('cargo')).toBe('crates.io')
    expect(osvEcosystem('composer')).toBe('Packagist')
    // System packages aren't queryable by name — better skipped than guessed.
    expect(osvEcosystem('pantry')).toBe('')
  })

  it('reads severity however OSV spelled it', () => {
    expect(severityOf({ database_specific: { severity: 'CRITICAL' } })).toBe('critical')
    expect(severityOf({ database_specific: { severity: 'medium' } })).toBe('moderate')
    expect(severityOf({ severity: [{ type: 'CVSS_V3', score: '9.8' }] })).toBe('critical')
    expect(severityOf({ severity: [{ type: 'CVSS_V3', score: '5.0' }] })).toBe('moderate')
    expect(severityOf({})).toBe('unknown')
  })

  it('leaves licences alone when there is no policy', () => {
    expect(checkLicense({ name: 'x', version: '1', license: 'AGPL-3.0' }, undefined)).toBeNull()
    expect(checkLicense({ name: 'x', version: '1' }, { deny: ['AGPL-3.0'] })).toBeNull()
  })
})

describe('SBOM export', () => {
  const entries = [
    { name: 'left-pad', version: '1.3.0', ecosystem: 'npm', license: 'MIT', sha256: 'abc123', resolved: 'https://registry.npmjs.org/left-pad.tgz', mirroredAt: '2026-01-01T00:00:00.000Z', key: 'k' },
    { name: '@acme/sdk', version: '2.0.0', ecosystem: 'npm', mirroredAt: '2026-01-01T00:00:00.000Z' },
  ]
  const options = { org: 'acme@example.com', timestamp: '2026-01-01T00:00:00.000Z' }

  it('produces CycloneDX a scanner can read', () => {
    const doc = toCycloneDx(entries, options) as any
    expect(doc.bomFormat).toBe('CycloneDX')
    expect(doc.specVersion).toBe('1.5')
    expect(doc.components).toHaveLength(2)
    expect(doc.components[0]).toMatchObject({
      name: 'left-pad',
      version: '1.3.0',
      purl: 'pkg:npm/left-pad@1.3.0',
      licenses: [{ license: { id: 'MIT' } }],
      hashes: [{ alg: 'SHA-256', content: 'abc123' }],
    })
  })

  it('produces SPDX with a relationship per package', () => {
    const doc = toSpdx(entries, options) as any
    expect(doc.spdxVersion).toBe('SPDX-2.3')
    expect(doc.packages).toHaveLength(2)
    expect(doc.relationships).toHaveLength(2)
    expect(doc.packages[1].licenseDeclared).toBe('NOASSERTION')
    expect(doc.packages[0].checksums).toEqual([{ algorithm: 'SHA256', checksumValue: 'abc123' }])
  })

  it('encodes scoped names as a valid purl', () => {
    expect(purlFor({ name: '@acme/sdk', version: '2.0.0', ecosystem: 'npm' })).toBe('pkg:npm/%40acme/sdk@2.0.0')
  })

  it('is deterministic — regenerating does not churn the file', () => {
    expect(JSON.stringify(buildSbom(entries, 'cyclonedx', options)))
      .toBe(JSON.stringify(buildSbom(entries, 'cyclonedx', options)))
    expect(JSON.stringify(buildSbom(entries, 'spdx', options)))
      .toBe(JSON.stringify(buildSbom(entries, 'spdx', options)))
  })
})

// ---------------------------------------------------------------------------
// Through the server, with plans and teams
// ---------------------------------------------------------------------------

describe('the paid consumer features, end to end', () => {
  let port: number
  let baseUrl: string
  let server: ReturnType<typeof createServer>
  let auth: AuthService
  let storage: MemoryTarballStorage
  let registry: ReturnType<typeof createLocalRegistry>
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = ['PANTRY_REGISTRY_TOKEN', 'PANTRY_TOKEN', 'STRIPE_SECRET_KEY']

  async function account(email: string): Promise<{ token: string, session: string }> {
    await auth.signup(email, email.split('@')[0], 'password123')
    const { token } = await auth.createApiToken(email, 'test', { permissions: ['publish', 'read'] })
    const { sessionToken } = await auth.login(email, 'password123')
    return { token, session: sessionToken }
  }

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
    process.env.PANTRY_REGISTRY_TOKEN = ADMIN_TOKEN
    delete process.env.STRIPE_SECRET_KEY

    storage = new MemoryTarballStorage()
    setEnterpriseStores(
      new MirrorStore(storage, { fetcher: async () => bytesOf('artifact bytes') }),
      new SecurityStore(storage, async entries => new Map(
        entries.filter(e => e.name === 'left-pad').map(e => [`${e.name}@${e.version}`, [{
          type: 'vulnerability' as const,
          package: e.name,
          version: e.version,
          ecosystem: 'npm',
          id: 'GHSA-live',
          severity: 'critical' as const,
          summary: 'live test advisory',
        }]]),
      )),
    )

    port = await getAvailablePort()
    baseUrl = `http://localhost:${port}`
    const authStorage = new InMemoryAuthStorage()
    auth = new AuthService(authStorage)
    registry = createLocalRegistry(baseUrl)
    server = createServer(registry, port, undefined, undefined, undefined, undefined, authStorage)
    server.start()
  })

  afterEach(() => {
    server.stop()
    setEnterpriseStores(null, null)
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  const snapshot = (token: string, entries: unknown[]): Promise<Response> =>
    fetch(`${baseUrl}/mirror/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ entries }),
    })

  it('is refused on the free plan, and works once subscribed', async () => {
    const user = await account('solo@acme.com')

    const free = await snapshot(user.token, [{ name: 'left-pad', version: '1.3.0', resolved: 'https://x/left-pad.tgz' }])
    expect(free.status).toBe(402)
    expect((await free.json() as any).error).toContain('Build insurance')

    await auth.setSubscription('solo@acme.com', { tier: 'pro', status: 'active' })

    const paid = await snapshot(user.token, [{ name: 'left-pad', version: '1.3.0', resolved: 'https://x/left-pad.tgz' }])
    expect(paid.status).toBe(200)
    expect((await paid.json() as any).mirrored).toBe(1)
  })

  it('serves an insured artifact back', async () => {
    const user = await account('solo@acme.com')
    await auth.setSubscription('solo@acme.com', { tier: 'pro', status: 'active' })
    await snapshot(user.token, [{ name: 'left-pad', version: '1.3.0', resolved: 'https://x/left-pad.tgz' }])

    const res = await fetch(`${baseUrl}/mirror/left-pad/1.3.0/tarball`, { headers: { Authorization: `Bearer ${user.token}` } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('artifact bytes')
    expect(res.headers.get('x-pantry-sha256')).toBeTruthy()

    const missing = await fetch(`${baseUrl}/mirror/never-installed/9.9.9/tarball`, { headers: { Authorization: `Bearer ${user.token}` } })
    expect(missing.status).toBe(404)
  })

  it('shares one mirror across a team', async () => {
    const lead = await account('lead@acme.com')
    const dev = await account('dev@acme.com')
    await auth.setSubscription('lead@acme.com', { tier: 'team', status: 'active' })
    await auth.addTeamMember('lead@acme.com', 'dev@acme.com', 10)

    // The lead insures it...
    await snapshot(lead.token, [{ name: 'shared-dep', version: '1.0.0', resolved: 'https://x/shared.tgz' }])

    // ...and the member — personally on Free — can pull it.
    expect(await auth.getTier('dev@acme.com')).toBe('free')
    const res = await fetch(`${baseUrl}/mirror/shared-dep/1.0.0/tarball`, { headers: { Authorization: `Bearer ${dev.token}` } })
    expect(res.status).toBe(200)
  })

  it('reports alerts over the registered lockfile', async () => {
    const user = await account('solo@acme.com')
    await auth.setSubscription('solo@acme.com', { tier: 'pro', status: 'active' })

    const registered = await fetch(`${baseUrl}/security/watch`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${user.token}` },
      body: JSON.stringify({
        entries: [
          { name: 'left-pad', version: '1.3.0', ecosystem: 'npm', license: 'MIT' },
          { name: 'copyleft', version: '1.0.0', ecosystem: 'npm', license: 'AGPL-3.0' },
        ],
        policy: { deny: ['AGPL-3.0'] },
      }),
    })
    expect(registered.status).toBe(200)

    const report = await (await fetch(`${baseUrl}/security/alerts`, { headers: { Authorization: `Bearer ${user.token}` } })).json() as any
    expect(report.watched).toBe(2)
    expect(report.counts.critical).toBe(1)
    expect(report.counts.license).toBe(1)
    expect(report.alerts[0].id).toBe('GHSA-live')
  })

  it('exports an SBOM of what it insured', async () => {
    const user = await account('solo@acme.com')
    await auth.setSubscription('solo@acme.com', { tier: 'pro', status: 'active' })
    await snapshot(user.token, [{ name: 'left-pad', version: '1.3.0', resolved: 'https://x/left-pad.tgz', license: 'MIT' }])

    const cdx = await fetch(`${baseUrl}/sbom`, { headers: { Authorization: `Bearer ${user.token}` } })
    expect(cdx.status).toBe(200)
    expect(cdx.headers.get('content-disposition')).toContain('sbom.cdx.json')
    const doc = await cdx.json() as any
    expect(doc.bomFormat).toBe('CycloneDX')
    expect(doc.components[0].name).toBe('left-pad')
    // The hash came from bytes we stored ourselves, not from a claim.
    expect(doc.components[0].hashes[0].alg).toBe('SHA-256')

    const spdx = await fetch(`${baseUrl}/sbom?format=spdx`, { headers: { Authorization: `Bearer ${user.token}` } })
    expect((await spdx.json() as any).spdxVersion).toBe('SPDX-2.3')
  })

  it('falls back to the watch list for an SBOM when nothing is mirrored', async () => {
    const user = await account('solo@acme.com')
    await auth.setSubscription('solo@acme.com', { tier: 'pro', status: 'active' })
    await fetch(`${baseUrl}/security/watch`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${user.token}` },
      body: JSON.stringify({ entries: [{ name: 'watched-only', version: '1.0.0', ecosystem: 'npm' }] }),
    })

    const doc = await (await fetch(`${baseUrl}/sbom`, { headers: { Authorization: `Bearer ${user.token}` } })).json() as any
    expect(doc.components[0].name).toBe('watched-only')
  })

  describe('team-wide entitlements', () => {
    async function paidPackage(sellerToken: string, name: string): Promise<void> {
      const form = new FormData()
      form.set('metadata', JSON.stringify({ name, version: '1.0.0' }))
      form.set('tarball', new File([new Uint8Array(8)], `${name}.tgz`))
      await fetch(`${baseUrl}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${sellerToken}` }, body: form })
      await fetch(`${baseUrl}/packages/${name}/paywall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sellerToken}` },
        body: JSON.stringify({ price: 900 }),
      })
    }

    it('covers everyone on the team from one purchase', async () => {
      const seller = await account('seller@other.com')
      const lead = await account('lead@acme.com')
      const dev = await account('dev@acme.com')
      await auth.setSubscription('lead@acme.com', { tier: 'team', status: 'active' })
      await auth.addTeamMember('lead@acme.com', 'dev@acme.com', 10)

      await paidPackage(seller.token, 'org-wide')

      const download = (token: string): Promise<Response> =>
        fetch(`${baseUrl}/packages/org-wide/1.0.0/tarball`, { headers: { Authorization: `Bearer ${token}` } })

      expect((await download(lead.token)).status).toBe(402)
      expect((await download(dev.token)).status).toBe(402)

      // The org buys it once — the grant is written against the seat holder.
      await registry.metadata.putAccessGrant({
        packageName: 'org-wide',
        token: 'user:lead@acme.com',
        grantedAt: new Date().toISOString(),
      })

      expect((await download(lead.token)).status).toBe(200)
      expect((await download(dev.token)).status).toBe(200)

      // ...and nobody outside the team.
      const outsider = await account('outsider@example.com')
      expect((await download(outsider.token)).status).toBe(402)
    })
  })
})
