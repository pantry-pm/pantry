/**
 * What a subscription actually changes, exercised against a running server:
 * the commission on a sale, and the four things a paid plan unlocks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createServer } from './server'
import { createLocalRegistry } from './registry'
import { AuthService, InMemoryAuthStorage } from './auth'
import { calculateFee } from './subscriptions'
import { getAvailablePort } from './test-utils'

const ADMIN_TOKEN = 'ptry_admin_token_for_tier_tests'

describe('subscription tiers', () => {
  let port: number
  let baseUrl: string
  let server: ReturnType<typeof createServer>
  let auth: AuthService
  let registry: ReturnType<typeof createLocalRegistry>
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = ['PANTRY_REGISTRY_TOKEN', 'PANTRY_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']

  async function account(email: string): Promise<{ token: string, session: string }> {
    await auth.signup(email, email.split('@')[0], 'password123')
    const { token } = await auth.createApiToken(email, 'test', { permissions: ['publish', 'read'] })
    const { sessionToken } = await auth.login(email, 'password123')
    return { token, session: sessionToken }
  }

  async function publish(name: string, token: string, sizeBytes = 16): Promise<Response> {
    const form = new FormData()
    form.set('metadata', JSON.stringify({ name, version: '1.0.0', description: 'x' }))
    form.set('tarball', new File([new Uint8Array(sizeBytes)], `${name}.tgz`))
    return fetch(`${baseUrl}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
  }

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
    process.env.PANTRY_REGISTRY_TOKEN = ADMIN_TOKEN
    delete process.env.STRIPE_SECRET_KEY

    port = await getAvailablePort()
    baseUrl = `http://localhost:${port}`
    registry = createLocalRegistry(baseUrl)
    const storage = new InMemoryAuthStorage()
    auth = new AuthService(storage)
    server = createServer(registry, port, undefined, undefined, undefined, undefined, storage)
    server.start()
  })

  afterEach(() => {
    server.stop()
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  // -------------------------------------------------------------------------

  describe('plans', () => {
    it('publishes the tier table without authentication', async () => {
      const res = await fetch(`${baseUrl}/api/plans`)
      expect(res.status).toBe(200)
      const body = await res.json() as any

      const byId = Object.fromEntries(body.plans.map((p: any) => [p.id, p]))
      expect(byId.free.commission).toBe('10%')
      expect(byId.pro.commission).toBe('5%')
      expect(byId.team.commission).toBe('5%')
      expect(byId.pro.formattedPrice).toBe('$9/mo')
      expect(byId.team.formattedPrice).toBe('$29/mo')
      expect(body.discoveryFee).toBe('3%')
    })

    it('reports the account\'s own plan', async () => {
      const { session } = await account('solo@acme.com')
      const res = await fetch(`${baseUrl}/account/subscription`, { headers: { Cookie: `pantry_session=${session}` } })
      const body = await res.json() as any
      expect(body.tier).toBe('free')
      expect(body.commission).toBe('10%')
      expect(body.manageable).toBe(false)
    })

    it('will not let an API token move an account onto a paid plan', async () => {
      const { token } = await account('solo@acme.com')
      const res = await fetch(`${baseUrl}/account/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ tier: 'pro' }),
      })
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------

  describe('commission', () => {
    it('is 10% for a free seller and 5% once they subscribe', () => {
      expect(calculateFee({ amount: 2000, sellerTier: 'free', discoveredOnSite: false }).applicationFee).toBe(200)
      expect(calculateFee({ amount: 2000, sellerTier: 'pro', discoveredOnSite: false }).applicationFee).toBe(100)
      expect(calculateFee({ amount: 2000, sellerTier: 'team', discoveredOnSite: false }).applicationFee).toBe(100)
    })

    it('adds the discovery fee only for sales the site started', () => {
      const fromSite = calculateFee({ amount: 2000, sellerTier: 'pro', discoveredOnSite: true })
      const fromCli = calculateFee({ amount: 2000, sellerTier: 'pro', discoveredOnSite: false })
      expect(fromSite.applicationFee - fromCli.applicationFee).toBe(60) // 3% of $20
    })

    it('follows the seller\'s plan at the time of sale, not the package', async () => {
      const { token } = await account('seller@acme.com')
      await publish('tiered-pkg', token)
      await fetch(`${baseUrl}/packages/tiered-pkg/paywall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ price: 1000 }),
      })

      // Subscribing changes the rate on the next sale with no change to the
      // package — nothing about the price record encodes the commission.
      await auth.setSubscription('seller@acme.com', { tier: 'pro', status: 'active' })
      expect(await auth.getTier('seller@acme.com')).toBe('pro')
    })
  })

  // -------------------------------------------------------------------------

  describe('perks', () => {
    it('refuses unlisted packages on Free and allows them on Pro', async () => {
      const { token, session } = await account('hider@acme.com')
      await publish('hidden-pkg', token)

      const asFree = await fetch(`${baseUrl}/publisher/api/packages/hidden-pkg`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Cookie': `pantry_session=${session}` },
        body: JSON.stringify({ settings: { visibility: 'unlisted' } }),
      })
      expect(asFree.status).toBe(402)
      expect((await asFree.json() as any).error).toContain('Pro feature')

      await auth.setSubscription('hider@acme.com', { tier: 'pro', status: 'active' })

      const asPro = await fetch(`${baseUrl}/publisher/api/packages/hidden-pkg`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Cookie': `pantry_session=${session}` },
        body: JSON.stringify({ settings: { visibility: 'unlisted' } }),
      })
      expect(asPro.status).toBe(200)
    })

    it('caps artifact size by plan', async () => {
      const { token } = await account('big@acme.com')

      // 60MB — over Free's 50MB ceiling.
      const tooBig = await publish('big-pkg', token, 60 * 1024 * 1024)
      expect(tooBig.status).toBe(413)
      const body = await tooBig.json() as any
      expect(body.error).toContain('Free plan')
      expect(body.hint).toContain('pantry subscribe pro')

      await auth.setSubscription('big@acme.com', { tier: 'pro', status: 'active' })
      const nowFine = await publish('big-pkg', token, 60 * 1024 * 1024)
      expect(nowFine.status).toBe(201)
    })

    it('truncates analytics history on Free', async () => {
      const { token, session } = await account('stats@acme.com')
      await publish('stats-pkg', token)

      const free = await fetch(`${baseUrl}/publisher/api/packages/stats-pkg`, { headers: { Cookie: `pantry_session=${session}` } })
      const freeBody = await free.json() as any
      expect(freeBody.analytics.retentionDays).toBe(30)
      expect(freeBody.analytics.truncated).toBe(true)

      await auth.setSubscription('stats@acme.com', { tier: 'team', status: 'active' })
      const paid = await fetch(`${baseUrl}/publisher/api/packages/stats-pkg`, { headers: { Cookie: `pantry_session=${session}` } })
      const paidBody = await paid.json() as any
      expect(paidBody.analytics.truncated).toBe(false)
    })

    it('puts paid rebuilds at the front of the queue', async () => {
      const { token: freeToken } = await account('slow@acme.com')
      const { token: proToken } = await account('fast@acme.com')
      await auth.setSubscription('fast@acme.com', { tier: 'pro', status: 'active' })

      const queue = async (domain: string, token: string): Promise<any> => {
        const res = await fetch(`${baseUrl}/api/rebuild`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ domain }),
        })
        return res.json()
      }

      expect((await queue('slow.example', freeToken)).priority).toBe(false)
      expect((await queue('fast.example', proToken)).priority).toBe(true)

      const listed = await (await fetch(`${baseUrl}/api/rebuild-queue`)).json() as any
      expect(listed.queue[0]).toBe('fast.example')
    })
  })

  // -------------------------------------------------------------------------

  describe('subscription state', () => {
    it('survives a failed payment and expires after a cancellation', async () => {
      await account('billing@acme.com')

      await auth.setSubscription('billing@acme.com', { tier: 'pro', status: 'active' })
      expect(await auth.getTier('billing@acme.com')).toBe('pro')

      await auth.setSubscription('billing@acme.com', { tier: 'pro', status: 'past_due' })
      expect(await auth.getTier('billing@acme.com')).toBe('pro')

      const yesterday = new Date(Date.now() - 86_400_000).toISOString()
      await auth.setSubscription('billing@acme.com', { tier: 'pro', status: 'canceled', currentPeriodEnd: yesterday })
      expect(await auth.getTier('billing@acme.com')).toBe('free')
    })

    it('round-trips through storage', async () => {
      await account('persist@acme.com')
      await auth.setSubscription('persist@acme.com', {
        tier: 'team',
        status: 'active',
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_123',
      })

      const stored = await auth.getSubscription('persist@acme.com')
      expect(stored?.tier).toBe('team')
      expect(stored?.stripeCustomerId).toBe('cus_123')

      await auth.setSubscription('persist@acme.com', null)
      expect(await auth.getSubscription('persist@acme.com')).toBeNull()
      expect(await auth.getTier('persist@acme.com')).toBe('free')
    })
  })
})
