/**
 * Paid packages — publish something and charge for it.
 *
 * The shape of it:
 *
 *   1. A publisher signs up, publishes a package, and sets a price. Only the
 *      account that published a package may price it.
 *   2. The package's *metadata* stays public — that's how anyone finds it and
 *      decides to buy. The *tarball* is what's gated.
 *   3. A buyer signs in, pays through Stripe Checkout, and the webhook records
 *      an entitlement against their **account**.
 *   4. Any token that account owns can then download it, on any machine, for
 *      as long as the entitlement lasts.
 *
 * Entitlements are keyed to accounts rather than to a token string, which is
 * what an earlier version did. Tokens get rotated, revoked and issued per
 * machine; a purchase should survive all three. It also keeps tokens out of
 * checkout URLs, where they would end up in browser history, in Stripe's
 * dashboard, and in the referrer of every link on the success page.
 *
 * The storage layer keys grants by an opaque subject string, so account
 * entitlements are stored as `user:<email>` and grants written by the older
 * token-based flow keep working unchanged.
 *
 * Publisher flow:
 *   POST   /packages/{name}/paywall   — set the price (owner only)
 *   DELETE /packages/{name}/paywall   — stop charging (owner only)
 *
 * Buyer flow:
 *   GET  /packages/{name}/buy         — browser: sign in, then Stripe Checkout
 *   POST /packages/{name}/checkout    — CLI: returns the checkout URL
 *   GET  /packages/{name}/{v}/tarball — 402 until the account is entitled
 */

import type { MetadataStorage, PackagePaywall, PackageAccessGrant } from './types'

// ---------------------------------------------------------------------------
// Stripe configuration
//
// Read lazily. A module-load snapshot bakes in whatever the environment looked
// like at import time, which is empty in tests and — more importantly — empty
// in any process that loads this before its secrets are populated.
// ---------------------------------------------------------------------------

function stripeSecretKey(): string {
  return process.env.STRIPE_SECRET_KEY || ''
}

function stripeWebhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET || ''
}

/** Whether payments are configured at all. */
export function paymentsEnabled(): boolean {
  return stripeSecretKey().length > 0
}

/**
 * The platform's cut of a sale, in basis points (100 = 1%). Only applies when
 * the publisher has connected a payout account; without one the whole charge
 * stays on the platform account and there is nothing to take a fee from.
 */
function platformFeeBps(): number {
  const raw = Number.parseInt(process.env.PANTRY_PLATFORM_FEE_BPS || '0', 10)
  if (!Number.isFinite(raw) || raw < 0) return 0
  return Math.min(raw, 5000) // never more than half
}

/**
 * Encode a body the way Stripe's API expects: form-encoded, with nested
 * structures in bracket notation (`metadata[package]=x`, `line_items[0][price]=y`).
 *
 * Worth spelling out because the naive version — `String(value)` — turns a
 * nested object into the literal text `[object Object]`, and Stripe answers
 * with a 400 that names the parameter but not the reason.
 */
export function encodeStripeParams(body: Record<string, any>, prefix = ''): [string, string][] {
  const out: [string, string][] = []

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue
    const name = prefix ? `${prefix}[${key}]` : key

    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === 'object')
          out.push(...encodeStripeParams(item, `${name}[${i}]`))
        else
          out.push([`${name}[${i}]`, String(item)])
      })
    }
    else if (typeof value === 'object') {
      out.push(...encodeStripeParams(value, name))
    }
    else {
      out.push([name, String(value)])
    }
  }

  return out
}

async function stripeRequest(method: string, path: string, body?: Record<string, any>): Promise<any> {
  const key = stripeSecretKey()
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured')

  const url = `https://api.stripe.com/v1${path}`
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${key}`,
  }

  let fetchBody: string | undefined
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    fetchBody = new URLSearchParams(encodeStripeParams(body)).toString()
  }

  const res = await fetch(url, { method, headers, body: fetchBody })
  if (!res.ok) {
    const err = await res.text()
    // Log the full error for debugging, but throw a sanitized message: Stripe
    // errors can echo request parameters back, and those include the buyer.
    console.error(`Stripe ${method} ${path} failed (${res.status}):`, err)
    throw new Error(`Payment service error (${res.status})`)
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// Entitlement subjects
// ---------------------------------------------------------------------------

/** The storage key for an account's entitlement. */
export function accountSubject(email: string): string {
  return `user:${email.toLowerCase().trim()}`
}

/** Who is asking, as far as the registry could tell. */
export interface Buyer {
  /** Account email, when the caller is authenticated. */
  userId?: string | null
  /** Raw bearer token, for entitlements granted before accounts were used. */
  token?: string | null
  /** True for the shared registry token. */
  admin?: boolean
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export interface AccessResult {
  allowed: boolean
  paywall?: PackagePaywall
  /** Why access was granted or refused — surfaced in the 402 body and in tests. */
  reason?: 'no-paywall' | 'free-version' | 'owner' | 'admin' | 'entitled' | 'unauthenticated' | 'payment-required' | 'expired'
}

/**
 * Decide whether this caller may download this version.
 *
 * Order matters: the publisher and the operator must never be locked out of a
 * package by its own price, and a version explicitly marked free must stay free
 * even for people who have not paid.
 */
export async function resolveAccess(
  storage: MetadataStorage,
  packageName: string,
  version: string,
  buyer: Buyer,
  ownerEmail?: string | null,
): Promise<AccessResult> {
  const paywall = await storage.getPaywall(packageName)

  if (!paywall || !paywall.enabled)
    return { allowed: true, reason: 'no-paywall' }

  if (paywall.freeVersions?.includes(version))
    return { allowed: true, paywall, reason: 'free-version' }

  if (buyer.admin)
    return { allowed: true, paywall, reason: 'admin' }

  const email = buyer.userId?.toLowerCase().trim()
  if (email && ownerEmail && email === ownerEmail.toLowerCase().trim())
    return { allowed: true, paywall, reason: 'owner' }

  if (email) {
    const grant = await storage.getAccessGrant(packageName, accountSubject(email))
    if (grant) {
      if (grant.expiresAt && new Date(grant.expiresAt) < new Date())
        return { allowed: false, paywall, reason: 'expired' }
      return { allowed: true, paywall, reason: 'entitled' }
    }
  }

  // Entitlements written before purchases were tied to accounts.
  if (buyer.token) {
    const legacy = await storage.getAccessGrant(packageName, buyer.token)
    if (legacy)
      return { allowed: true, paywall, reason: 'entitled' }
  }

  return {
    allowed: false,
    paywall,
    // "Sign in" and "buy it" are different instructions, and a caller that
    // presented a credential has already done the first one.
    reason: email || buyer.token ? 'payment-required' : 'unauthenticated',
  }
}

/**
 * Backwards-compatible wrapper for callers that only have a bearer token.
 * Prefer `resolveAccess`, which can see the account behind the token.
 */
export async function checkPaywallAccess(
  storage: MetadataStorage,
  packageName: string,
  version: string,
  authToken: string | null,
): Promise<{ allowed: boolean, paywall?: PackagePaywall, reason?: string }> {
  const result = await resolveAccess(storage, packageName, version, { token: authToken })
  return {
    allowed: result.allowed,
    paywall: result.paywall,
    reason: result.allowed
      ? undefined
      : result.reason === 'unauthenticated'
        ? 'Authentication required for paid package'
        : 'Payment required',
  }
}

/** Whether an account already owns a package (used by the buy flow and the UI). */
export async function isEntitled(
  storage: MetadataStorage,
  packageName: string,
  email: string,
): Promise<boolean> {
  const grant = await storage.getAccessGrant(packageName, accountSubject(email))
  if (!grant) return false
  if (grant.expiresAt && new Date(grant.expiresAt) < new Date()) return false
  return true
}

// ---------------------------------------------------------------------------
// Pricing (publisher)
// ---------------------------------------------------------------------------

/** Currencies Stripe Checkout supports that we're willing to render. */
const SUPPORTED_CURRENCIES = new Set(['usd', 'eur', 'gbp', 'cad', 'aud', 'chf', 'jpy', 'sek', 'nok', 'dkk'])

/** The smallest charge worth making: below this, fees eat the sale. */
export const MIN_PRICE_CENTS = 100
/** A sanity ceiling. A five-figure package price is a typo, not a business. */
export const MAX_PRICE_CENTS = 100_000_00

export interface PriceConfig {
  price: number
  currency?: string
  freeVersions?: string[]
  trialDays?: number
  /** Stripe Connect account to pay out to (`acct_…`). */
  payoutAccountId?: string
}

/** Validate a publisher-supplied price. Returns an error message, or null. */
export function validatePriceConfig(config: PriceConfig): string | null {
  if (typeof config.price !== 'number' || !Number.isInteger(config.price))
    return 'Price must be a whole number of cents (e.g. 900 for $9.00)'
  if (config.price < MIN_PRICE_CENTS)
    return `Price must be at least ${MIN_PRICE_CENTS} cents ($${(MIN_PRICE_CENTS / 100).toFixed(2)})`
  if (config.price > MAX_PRICE_CENTS)
    return `Price must be at most ${MAX_PRICE_CENTS} cents ($${(MAX_PRICE_CENTS / 100).toFixed(2)})`

  const currency = (config.currency || 'usd').toLowerCase()
  if (!SUPPORTED_CURRENCIES.has(currency))
    return `Unsupported currency "${currency}" — one of: ${[...SUPPORTED_CURRENCIES].join(', ')}`

  if (config.freeVersions && !Array.isArray(config.freeVersions))
    return 'freeVersions must be an array of version strings'
  if (config.freeVersions?.some(v => typeof v !== 'string' || v.length > 64))
    return 'freeVersions must be version strings'

  if (config.payoutAccountId && !/^acct_[A-Za-z0-9]+$/.test(config.payoutAccountId))
    return 'payoutAccountId must be a Stripe Connect account id (acct_…)'

  if (config.trialDays !== undefined && (!Number.isInteger(config.trialDays) || config.trialDays < 0 || config.trialDays > 365))
    return 'trialDays must be a whole number of days between 0 and 365'

  return null
}

/**
 * Set (or update) a package's price.
 *
 * Stripe objects are created only when payments are configured, so a registry
 * without Stripe keys can still be developed and tested against — it just can't
 * take money. Prices in Stripe are immutable, so a change creates a new one and
 * repoints the product at it.
 */
export async function configurePaywall(
  storage: MetadataStorage,
  packageName: string,
  config: PriceConfig,
): Promise<PackagePaywall> {
  const invalid = validatePriceConfig(config)
  if (invalid) throw new Error(invalid)

  const now = new Date().toISOString()
  const existing = await storage.getPaywall(packageName)
  const currency = (config.currency || existing?.currency || 'usd').toLowerCase()

  let stripeProductId = existing?.stripeProductId
  let stripePriceId = existing?.stripePriceId

  if (paymentsEnabled()) {
    if (!stripeProductId) {
      const product = await stripeRequest('POST', '/products', {
        name: packageName,
        description: `Access to ${packageName} on the pantry registry`,
        metadata: { pantry_package: packageName },
      })
      stripeProductId = product.id
    }

    // Only mint a new Stripe price when the amount or currency actually
    // changed — otherwise every dashboard save leaves another orphan behind.
    const priceChanged = !stripePriceId
      || existing?.price !== config.price
      || existing?.currency?.toLowerCase() !== currency
    if (priceChanged) {
      const price = await stripeRequest('POST', '/prices', {
        product: stripeProductId,
        unit_amount: String(config.price),
        currency,
      })
      stripePriceId = price.id
    }
  }

  const paywall: PackagePaywall = {
    name: packageName,
    enabled: true,
    price: config.price,
    currency,
    stripeProductId,
    stripePriceId,
    stripeAccountId: config.payoutAccountId ?? existing?.stripeAccountId,
    freeVersions: config.freeVersions ?? existing?.freeVersions,
    trialDays: config.trialDays ?? existing?.trialDays,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }

  await storage.putPaywall(paywall)
  return paywall
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export interface CheckoutRequest {
  packageName: string
  /** The account being charged. Entitlement is granted to this address. */
  email: string
  baseUrl: string
}

/**
 * Start a Stripe Checkout session for one account.
 *
 * The buyer's account travels in `metadata` and comes back on the webhook —
 * that, and not anything in the URL, is what the entitlement is written
 * against, so the success URL is safe to share and safe to log.
 */
export async function createCheckoutSession(
  storage: MetadataStorage,
  request: CheckoutRequest,
): Promise<{ url: string }> {
  const { packageName, email, baseUrl } = request

  const paywall = await storage.getPaywall(packageName)
  if (!paywall || !paywall.enabled)
    throw new Error('This package is not for sale')

  if (!paymentsEnabled())
    throw new Error('Payments are not configured on this registry')

  if (!paywall.stripePriceId)
    throw new Error('This package has a price but no Stripe price — the publisher should save it again')

  const encoded = encodeURIComponent(packageName)
  const fee = platformFeeBps()

  const session = await stripeRequest('POST', '/checkout/sessions', {
    'mode': 'payment',
    'line_items[0][price]': paywall.stripePriceId,
    'line_items[0][quantity]': '1',
    'customer_email': email,
    // Reconciliation only — Stripe does not dedupe on this, so it prevents
    // nothing; what prevents a second charge is the entitlement check before
    // this function is called, which short-circuits once the first payment has
    // landed. Two sessions opened before either completes can both be paid,
    // the same as any Checkout integration.
    'client_reference_id': `${packageName}:${email}`,
    'success_url': `${baseUrl}/packages/${encoded}/checkout/success`,
    'cancel_url': `${baseUrl}/pkg/${encoded}`,
    'metadata[package_name]': packageName,
    'metadata[buyer_email]': email,
    // Marketplace payouts: with a connected account the money lands there and
    // the platform keeps its fee; without one it stays on the platform account.
    ...(paywall.stripeAccountId
      ? {
          'payment_intent_data[transfer_data][destination]': paywall.stripeAccountId,
          ...(fee > 0
            ? { 'payment_intent_data[application_fee_amount]': String(Math.round((paywall.price * fee) / 10_000)) }
            : {}),
        }
      : {}),
  })

  return { url: session.url }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

const processedWebhookEvents = new Map<string, number>() // eventId -> timestamp
const WEBHOOK_DEDUP_TTL = 10 * 60 * 1000 // 10 minutes

export async function handleStripeWebhook(
  storage: MetadataStorage,
  rawBody: string,
  signature: string,
): Promise<{ processed: boolean, granted?: string }> {
  if (!stripeWebhookSecret())
    throw new Error('STRIPE_WEBHOOK_SECRET not configured')

  const event = await verifyStripeWebhook(rawBody, signature)

  // Stripe retries until it gets a 2xx, so the same event arrives more than once.
  if (event.id) {
    if (processedWebhookEvents.has(event.id))
      return { processed: true }
    processedWebhookEvents.set(event.id, Date.now())
    if (processedWebhookEvents.size > 100) {
      const now = Date.now()
      for (const [id, ts] of processedWebhookEvents) {
        if (now - ts > WEBHOOK_DEDUP_TTL) processedWebhookEvents.delete(id)
      }
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const packageName: string | undefined = session.metadata?.package_name
    const email: string | undefined = session.metadata?.buyer_email
    // A session can complete with payment still pending (bank debits). Only an
    // actually-paid session buys anything.
    const paid = !session.payment_status || session.payment_status === 'paid' || session.payment_status === 'no_payment_required'

    if (packageName && email && paid) {
      const grant: PackageAccessGrant = {
        packageName,
        token: accountSubject(email),
        stripePaymentId: session.payment_intent || session.id,
        grantedAt: new Date().toISOString(),
      }
      await storage.putAccessGrant(grant)
      return { processed: true, granted: email }
    }

    // An older session, from when the buyer's token was the subject.
    const legacyToken: string | undefined = session.metadata?.access_token
    if (packageName && legacyToken && paid) {
      await storage.putAccessGrant({
        packageName,
        token: legacyToken,
        stripePaymentId: session.payment_intent || session.id,
        grantedAt: new Date().toISOString(),
      })
      return { processed: true }
    }
  }

  return { processed: false }
}

async function verifyStripeWebhook(rawBody: string, signature: string): Promise<any> {
  // Stripe signature header: t=timestamp,v1=hash
  const parts = signature.split(',').reduce((acc, part) => {
    const [key, value] = part.split('=')
    acc[key] = value
    return acc
  }, {} as Record<string, string>)

  const timestamp = parts.t
  const expectedSig = parts.v1

  if (!timestamp || !expectedSig)
    throw new Error('Invalid Stripe signature format')

  const payload = `${timestamp}.${rawBody}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(stripeWebhookSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const computedSig = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')

  const computedBuf = Buffer.from(computedSig)
  const expectedBuf = Buffer.from(expectedSig)
  if (computedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(computedBuf, expectedBuf))
    throw new Error('Stripe webhook signature verification failed')

  // Replay window. Without this a captured webhook stays valid forever.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (age > 300)
    throw new Error('Stripe webhook timestamp too old')

  try {
    return JSON.parse(rawBody)
  }
  catch {
    throw new Error('Invalid webhook body JSON')
  }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = {
  usd: '$',
  eur: '€',
  gbp: '£',
  cad: 'CA$',
  aud: 'A$',
  jpy: '¥',
}

/** Zero-decimal currencies: ¥500 is 500 units, not 5.00. */
const ZERO_DECIMAL = new Set(['jpy'])

export function formatPrice(price: number, currency: string): string {
  const code = (currency || 'usd').toLowerCase()
  const symbol = CURRENCY_SYMBOLS[code] || `${code.toUpperCase()} `
  if (ZERO_DECIMAL.has(code)) return `${symbol}${price}`
  return `${symbol}${(price / 100).toFixed(2)}`
}

/** Parse a human price ("9", "9.00", "$9.00") into cents. Null when it isn't one. */
export function parsePriceToCents(input: string, currency = 'usd'): number | null {
  const cleaned = input.trim().replace(/^[^\d.,-]+/, '').replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const amount = Number.parseFloat(cleaned)
  if (!Number.isFinite(amount)) return null
  const cents = ZERO_DECIMAL.has(currency.toLowerCase()) ? Math.round(amount) : Math.round(amount * 100)
  return cents
}
