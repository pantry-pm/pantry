/**
 * The paid-package flow, end to end against a running server:
 * sign up → publish → set a price → a stranger is refused → the buyer pays →
 * the buyer downloads.
 *
 * Stripe itself is not reachable from a test, so the purchase is delivered the
 * way Stripe delivers it in production: a signed `checkout.session.completed`
 * webhook. Everything either side of that boundary is the real code path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createServer } from './server'
import { createLocalRegistry } from './registry'
import { AuthService, InMemoryAuthStorage } from './auth'
import { accountSubject, encodeStripeParams, formatPrice, parsePriceToCents, validatePriceConfig } from './paywall'
import { getAvailablePort } from './test-utils'

const ADMIN_TOKEN = 'ptry_admin_token_for_paid_package_tests'
const WEBHOOK_SECRET = 'whsec_test_secret'

/** Sign a webhook body the way Stripe does, so the real verifier runs. */
async function stripeSignature(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`))
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
  return `t=${timestamp},v1=${hex}`
}

describe('paid packages', () => {
  let port: number
  let baseUrl: string
  let server: ReturnType<typeof createServer>
  let registry: ReturnType<typeof createLocalRegistry>
  let auth: AuthService
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = ['PANTRY_REGISTRY_TOKEN', 'PANTRY_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'REGISTRY_VISIBILITY']

  /** A publisher and a buyer, each with an account and an API token. */
  let publisherToken: string
  let buyerToken: string
  let strangerToken: string

  async function account(email: string, permissions: ('publish' | 'read')[] = ['publish', 'read']): Promise<string> {
    await auth.signup(email, email.split('@')[0], 'password123')
    const { token } = await auth.createApiToken(email, 'test', { permissions })
    return token
  }

  async function publish(name: string, version: string, token: string): Promise<Response> {
    const form = new FormData()
    form.set('metadata', JSON.stringify({ name, version, description: 'a package' }))
    form.set('tarball', new File([new Uint8Array([1, 2, 3, 4])], `${name}-${version}.tgz`))
    return fetch(`${baseUrl}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
  }

  async function setPrice(name: string, token: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/packages/${encodeURIComponent(name)}/paywall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  }

  function download(name: string, version: string, token?: string): Promise<Response> {
    return fetch(`${baseUrl}/packages/${encodeURIComponent(name)}/${version}/tarball`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  }

  /** Deliver the purchase the way Stripe would. */
  async function deliverPurchase(name: string, email: string, eventId = `evt_${Math.random().toString(36).slice(2)}`): Promise<Response> {
    const body = JSON.stringify({
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          payment_status: 'paid',
          payment_intent: 'pi_test_123',
          metadata: { package_name: name, buyer_email: email },
        },
      },
    })
    return fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': await stripeSignature(body) },
      body,
    })
  }

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
    process.env.PANTRY_REGISTRY_TOKEN = ADMIN_TOKEN
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    delete process.env.STRIPE_SECRET_KEY // no live Stripe calls from tests
    delete process.env.REGISTRY_VISIBILITY

    port = await getAvailablePort()
    baseUrl = `http://localhost:${port}`
    registry = createLocalRegistry(baseUrl)
    const authStorage = new InMemoryAuthStorage()
    auth = new AuthService(authStorage)
    server = createServer(registry, port, undefined, undefined, undefined, undefined, authStorage)
    server.start()

    publisherToken = await account('publisher@acme.com')
    buyerToken = await account('buyer@acme.com')
    strangerToken = await account('stranger@acme.com')
  })

  afterEach(() => {
    server.stop()
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  // -------------------------------------------------------------------------

  describe('pricing', () => {
    it('lets the publisher price their own package', async () => {
      expect((await publish('paid-lib', '1.0.0', publisherToken)).status).toBe(201)

      const res = await setPrice('paid-lib', publisherToken, { price: 900 })
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.paywall.price).toBe(900)
      expect(body.paywall.formattedPrice).toBe('$9.00')
    })

    it('refuses to let another account price it', async () => {
      await publish('paid-lib', '1.0.0', publisherToken)

      const res = await setPrice('paid-lib', strangerToken, { price: 100000 })
      expect(res.status).toBe(403)
      expect((await res.json() as any).error).toContain('publisher')

      // ...and the package stays free.
      expect((await download('paid-lib', '1.0.0')).status).toBe(200)
    })

    it('refuses to let another account remove the price', async () => {
      await publish('paid-lib', '1.0.0', publisherToken)
      await setPrice('paid-lib', publisherToken, { price: 900 })

      const res = await fetch(`${baseUrl}/packages/paid-lib/paywall`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${strangerToken}` },
      })
      expect(res.status).toBe(403)
      expect((await download('paid-lib', '1.0.0')).status).toBe(402)
    })

    it('rejects prices that are not sane', async () => {
      await publish('paid-lib', '1.0.0', publisherToken)

      for (const bad of [{ price: 50 }, { price: 9.99 }, { price: 900, currency: 'xyz' }, { price: 900, payoutAccountId: 'nope' }]) {
        const res = await setPrice('paid-lib', publisherToken, bad)
        expect(res.status).toBe(400)
      }
    })

    it('lets the publisher take the price off again', async () => {
      await publish('paid-lib', '1.0.0', publisherToken)
      await setPrice('paid-lib', publisherToken, { price: 900 })
      expect((await download('paid-lib', '1.0.0')).status).toBe(402)

      const res = await fetch(`${baseUrl}/packages/paid-lib/paywall`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${publisherToken}` },
      })
      expect(res.status).toBe(200)
      expect((await download('paid-lib', '1.0.0')).status).toBe(200)
    })
  })

  // -------------------------------------------------------------------------

  describe('access', () => {
    beforeEach(async () => {
      await publish('paid-lib', '1.0.0', publisherToken)
      await publish('paid-lib', '2.0.0', publisherToken)
      await setPrice('paid-lib', publisherToken, { price: 1500, freeVersions: ['1.0.0'] })
    })

    it('serves metadata to everyone — that is how you decide to buy', async () => {
      const res = await fetch(`${baseUrl}/packages/paid-lib`)
      expect(res.status).toBe(200)

      const price = await fetch(`${baseUrl}/packages/paid-lib/paywall`)
      expect(price.status).toBe(200)
      const body = await price.json() as any
      expect(body.enabled).toBe(true)
      expect(body.formattedPrice).toBe('$15.00')
      expect(body.owned).toBe(false)
    })

    it('refuses the download to an anonymous caller, and says what it costs', async () => {
      const res = await download('paid-lib', '2.0.0')
      expect(res.status).toBe(402)
      const body = await res.json() as any
      expect(body.formattedPrice).toBe('$15.00')
      expect(body.buyUrl).toContain('/packages/paid-lib/buy')
      expect(body.message).toContain('pantry buy paid-lib')
    })

    it('refuses a signed-in stranger who has not paid', async () => {
      expect((await download('paid-lib', '2.0.0', strangerToken)).status).toBe(402)
    })

    it('never locks the publisher out of their own package', async () => {
      expect((await download('paid-lib', '2.0.0', publisherToken)).status).toBe(200)
    })

    it('lets the operator through', async () => {
      expect((await download('paid-lib', '2.0.0', ADMIN_TOKEN)).status).toBe(200)
    })

    it('keeps versions marked free free', async () => {
      expect((await download('paid-lib', '1.0.0')).status).toBe(200)
    })
  })

  // -------------------------------------------------------------------------

  describe('purchase', () => {
    beforeEach(async () => {
      await publish('paid-lib', '1.0.0', publisherToken)
      await setPrice('paid-lib', publisherToken, { price: 900 })
    })

    it('entitles the buyer\'s account, not one token', async () => {
      expect((await download('paid-lib', '1.0.0', buyerToken)).status).toBe(402)

      const hook = await deliverPurchase('paid-lib', 'buyer@acme.com')
      expect(hook.status).toBe(200)
      expect((await hook.json() as any).granted).toBe('buyer@acme.com')

      expect((await download('paid-lib', '1.0.0', buyerToken)).status).toBe(200)

      // A second token on the same account works too — a purchase survives
      // rotating credentials and adding machines.
      const { token: second } = await auth.createApiToken('buyer@acme.com', 'laptop', { permissions: ['read'] })
      expect((await download('paid-lib', '1.0.0', second)).status).toBe(200)

      // And nobody else got anything.
      expect((await download('paid-lib', '1.0.0', strangerToken)).status).toBe(402)
    })

    it('reports ownership back to the buyer', async () => {
      await deliverPurchase('paid-lib', 'buyer@acme.com')
      const res = await fetch(`${baseUrl}/packages/paid-lib/paywall`, {
        headers: { Authorization: `Bearer ${buyerToken}` },
      })
      expect((await res.json() as any).owned).toBe(true)
    })

    it('ignores a webhook that is not signed by Stripe', async () => {
      const body = JSON.stringify({
        id: 'evt_forged',
        type: 'checkout.session.completed',
        data: { object: { payment_status: 'paid', metadata: { package_name: 'paid-lib', buyer_email: 'stranger@acme.com' } } },
      })
      const res = await fetch(`${baseUrl}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': await stripeSignature(body, 'whsec_wrong_secret') },
        body,
      })
      expect(res.status).toBe(400)
      expect((await download('paid-lib', '1.0.0', strangerToken)).status).toBe(402)
    })

    it('does not grant access for a session that has not been paid', async () => {
      const body = JSON.stringify({
        id: 'evt_unpaid',
        type: 'checkout.session.completed',
        data: { object: { payment_status: 'unpaid', metadata: { package_name: 'paid-lib', buyer_email: 'buyer@acme.com' } } },
      })
      await fetch(`${baseUrl}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': await stripeSignature(body) },
        body,
      })
      expect((await download('paid-lib', '1.0.0', buyerToken)).status).toBe(402)
    })

    it('is idempotent — Stripe retries until it gets a 2xx', async () => {
      await deliverPurchase('paid-lib', 'buyer@acme.com', 'evt_same')
      const second = await deliverPurchase('paid-lib', 'buyer@acme.com', 'evt_same')
      expect(second.status).toBe(200)
      expect((await download('paid-lib', '1.0.0', buyerToken)).status).toBe(200)
    })

    it('tells an anonymous checkout request to sign in', async () => {
      const res = await fetch(`${baseUrl}/packages/paid-lib/checkout`, { method: 'POST' })
      expect(res.status).toBe(401)
    })

    it('short-circuits checkout for someone who already owns it', async () => {
      await deliverPurchase('paid-lib', 'buyer@acme.com')
      const res = await fetch(`${baseUrl}/packages/paid-lib/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${buyerToken}` },
      })
      expect(res.status).toBe(200)
      expect((await res.json() as any).owned).toBe(true)
    })

    it('sends an unauthenticated browser to sign in before paying', async () => {
      const res = await fetch(`${baseUrl}/packages/paid-lib/buy`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toContain('/login?next=')
    })

    it('reports honestly when payments are not configured', async () => {
      const res = await fetch(`${baseUrl}/packages/paid-lib/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${buyerToken}` },
      })
      expect(res.status).toBe(400)
      expect((await res.json() as any).error).toContain('not configured')
    })
  })

  // -------------------------------------------------------------------------

  describe('helpers', () => {
    it('keys entitlements by a normalised account', () => {
      expect(accountSubject('  Buyer@Acme.com ')).toBe('user:buyer@acme.com')
    })

    it('parses human prices into cents', () => {
      expect(parsePriceToCents('9')).toBe(900)
      expect(parsePriceToCents('9.00')).toBe(900)
      expect(parsePriceToCents('$19.99')).toBe(1999)
      expect(parsePriceToCents('1,299.50')).toBe(129950)
      expect(parsePriceToCents('500', 'jpy')).toBe(500)
      expect(parsePriceToCents('free')).toBeNull()
      expect(parsePriceToCents('9.999')).toBeNull()
    })

    it('formats what it parsed', () => {
      expect(formatPrice(parsePriceToCents('19.99')!, 'usd')).toBe('$19.99')
    })

    it('encodes nested Stripe params in bracket notation', () => {
      // Regression: `String({...})` produced the literal "[object Object]" and
      // Stripe answered 400 "Metadata must be a single object containing
      // key-value pairs" — which no test caught, because no test called Stripe.
      expect(encodeStripeParams({ name: 'pkg', metadata: { pantry_package: 'pkg' } })).toEqual([
        ['name', 'pkg'],
        ['metadata[pantry_package]', 'pkg'],
      ])

      expect(encodeStripeParams({
        mode: 'payment',
        line_items: [{ price: 'price_1', quantity: 1 }],
        payment_intent_data: { transfer_data: { destination: 'acct_1' } },
      })).toEqual([
        ['mode', 'payment'],
        ['line_items[0][price]', 'price_1'],
        ['line_items[0][quantity]', '1'],
        ['payment_intent_data[transfer_data][destination]', 'acct_1'],
      ])

      // Undefined values are dropped rather than sent as the string "undefined".
      expect(encodeStripeParams({ a: 'x', b: undefined, c: null })).toEqual([['a', 'x']])
    })

    it('states why a price is invalid', () => {
      expect(validatePriceConfig({ price: 900 })).toBeNull()
      expect(validatePriceConfig({ price: 1 })).toContain('at least')
      expect(validatePriceConfig({ price: 900, currency: 'xyz' })).toContain('Unsupported currency')
    })
  })
})
