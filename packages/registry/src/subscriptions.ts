/**
 * Subscriptions and the selling fee.
 *
 * Publishing is free and installing is free. *Selling* a package costs a fee
 * per sale, paid to the registry — and a plan halves it:
 *
 *   Free          10% per sale   public packages, 30 days of full analytics, 50MB
 *   Pro    $9/mo   5% per sale   + private packages, full history, 250MB, priority builds
 *   Team  $29/mo   5% per sale   + 10 seats, 1GB artifacts
 *
 * Concretely: list a package at $10 and sell one copy, and $1 goes to the
 * registry on Free, or 50c on a plan. Payment processing and any sales tax are
 * on top of that, and settle against the seller.
 *
 * On top of the tier rate, a sale that started on pantry.dev carries a **3%
 * discovery fee**: the registry did the work of putting the package in front of
 * a buyer who wasn't looking for it. A sale someone initiated themselves
 * (`pantry buy` from a terminal, a link the publisher sent) doesn't.
 *
 * The percentages are ours, net. Stripe's own processing fees are settled
 * against the seller's connected account (`on_behalf_of`), so a 5% headline
 * rate stays 5% to us rather than 5% minus whatever the card cost.
 *
 * A subscription belongs to an **account**, not to a role: the same $9 applies
 * whether you're publishing packages or consuming them.
 */

export type Tier = 'free' | 'pro' | 'team'

export interface TierDefinition {
  id: Tier
  name: string
  /** Monthly price in cents. Zero for free. */
  price: number
  /**
   * What the seller pays us per sale, in basis points (100 = 1%). Taken out of
   * the sale price rather than added to it, so the buyer pays exactly what the
   * package is listed at.
   */
  commissionBps: number
  /**
   * How far back the *detailed* download timeline goes. Lifetime totals are
   * shown for every package on every plan — this is the depth, not the
   * existence, of analytics.
   */
  analyticsRetentionDays: number
  /** Largest tarball this account may publish, in bytes. */
  maxArtifactBytes: number
  /** May publish packages that are hidden from search and the index. */
  privatePackages: boolean
  /** Rebuild requests jump the build queue. */
  priorityBuilds: boolean
  /** How many accounts can manage this account's packages. */
  seats: number
  /** Mirror every artifact you install, and serve it after upstream is gone. */
  buildInsurance: boolean
  /** Continuous vulnerability and licence-policy alerts over your lockfile. */
  securityAlerts: boolean
  /** CycloneDX / SPDX export of everything you install. */
  sbomExport: boolean
  /** One purchase covers the whole team. */
  teamEntitlements: boolean
  /** Stripe `lookup_key` for the recurring price. Absent for free. */
  stripeLookupKey?: string
}

export const TIERS: Record<Tier, TierDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    commissionBps: 1000, // 10%
    analyticsRetentionDays: 30,
    maxArtifactBytes: 50 * 1024 * 1024,
    privatePackages: false,
    priorityBuilds: false,
    seats: 1,
    buildInsurance: false,
    securityAlerts: false,
    sbomExport: false,
    teamEntitlements: false,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: 900,
    commissionBps: 500, // 5%
    analyticsRetentionDays: 3650,
    maxArtifactBytes: 250 * 1024 * 1024,
    privatePackages: true,
    priorityBuilds: true,
    seats: 1,
    buildInsurance: true,
    securityAlerts: true,
    sbomExport: true,
    // Nothing to share on a single seat, but the machinery is the same.
    teamEntitlements: false,
    stripeLookupKey: 'pantry_pro_monthly',
  },
  team: {
    id: 'team',
    name: 'Team',
    price: 2900,
    commissionBps: 500, // 5% — same rate as Pro; Team buys seats and headroom
    analyticsRetentionDays: 3650,
    maxArtifactBytes: 1024 * 1024 * 1024,
    privatePackages: true,
    priorityBuilds: true,
    seats: 10,
    buildInsurance: true,
    securityAlerts: true,
    sbomExport: true,
    teamEntitlements: true,
    stripeLookupKey: 'pantry_team_monthly',
  },
}

/** Added to the tier rate when a sale started on pantry.dev. */
export const DISCOVERY_FEE_BPS = 300 // 3%

/** A fee above this would be indefensible however the rules stack up. */
const MAX_TOTAL_FEE_BPS = 3000 // 30%

export function tierOf(value: string | null | undefined): Tier {
  if (value === 'pro' || value === 'team') return value
  return 'free'
}

export function tierDefinition(tier: Tier): TierDefinition {
  return TIERS[tier]
}

/** Whether a subscription is currently entitled to its tier's benefits. */
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | 'none'

export interface AccountSubscription {
  tier: Tier
  status: SubscriptionStatus
  /** Stripe customer id, kept so the billing portal and renewals find them. */
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  /** When the paid period ends — a cancelled subscription keeps its tier until then. */
  currentPeriodEnd?: string
  updatedAt?: string
}

/**
 * The tier an account actually gets right now.
 *
 * `past_due` keeps its benefits: a card that failed at 3am should not take a
 * publisher's private packages offline before Stripe has finished retrying.
 * `canceled` keeps them until the period they already paid for runs out.
 */
export function effectiveTier(sub: AccountSubscription | null | undefined, now: Date = new Date()): Tier {
  if (!sub || sub.tier === 'free') return 'free'

  switch (sub.status) {
    case 'active':
    case 'trialing':
    case 'past_due':
      return sub.tier
    case 'canceled':
      return sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) > now ? sub.tier : 'free'
    default:
      return 'free'
  }
}

// ---------------------------------------------------------------------------
// The fee
// ---------------------------------------------------------------------------

export interface FeeInput {
  /** Sale price in cents. */
  amount: number
  /** The seller's tier at the moment of sale. */
  sellerTier: Tier
  /** Whether the sale was initiated from pantry.dev. */
  discoveredOnSite: boolean
}

export interface FeeBreakdown {
  /** What the buyer pays, unchanged — the fee comes out of the seller's side. */
  amount: number
  /** Tier rate in basis points. */
  commissionBps: number
  /** Discovery rate in basis points (0 when not applicable). */
  discoveryBps: number
  /** Total rate actually applied. */
  totalBps: number
  /** Our cut, in cents. */
  applicationFee: number
  /** What reaches the seller before Stripe's own processing fee. */
  sellerNet: number
}

/**
 * Work out our cut of a sale.
 *
 * Rounding is toward the seller: a half-cent goes to them, not to us. It is a
 * rounding error either way, and this is the direction that never needs
 * explaining to someone reading their payout statement.
 */
export function calculateFee(input: FeeInput): FeeBreakdown {
  const commissionBps = tierDefinition(input.sellerTier).commissionBps
  const discoveryBps = input.discoveredOnSite ? DISCOVERY_FEE_BPS : 0
  const totalBps = Math.min(commissionBps + discoveryBps, MAX_TOTAL_FEE_BPS)

  const applicationFee = Math.max(0, Math.min(Math.floor((input.amount * totalBps) / 10_000), input.amount))

  return {
    amount: input.amount,
    commissionBps,
    discoveryBps,
    totalBps,
    applicationFee,
    sellerNet: input.amount - applicationFee,
  }
}

/** "5%", "13%", "5.5%" — for receipts and dashboards. */
export function formatBps(bps: number): string {
  const percent = bps / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`
}

/**
 * How a sale reached the buyer. Recorded on the checkout session so a payout
 * can be explained months later, when nobody remembers where the click came
 * from.
 */
export type SaleOrigin = 'site' | 'cli' | 'api'

export function isDiscovery(origin: SaleOrigin): boolean {
  return origin === 'site'
}
