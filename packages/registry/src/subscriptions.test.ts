import { describe, expect, it } from 'bun:test'
import {
  calculateFee,
  DISCOVERY_FEE_BPS,
  effectiveTier,
  formatBps,
  isDiscovery,
  TIERS,
  tierDefinition,
  tierOf,
} from './subscriptions'

describe('tiers', () => {
  it('charges 10% on free and 5% on both paid tiers', () => {
    expect(TIERS.free.commissionBps).toBe(1000)
    expect(TIERS.pro.commissionBps).toBe(500)
    expect(TIERS.team.commissionBps).toBe(500)
  })

  it('prices Pro at $9 and Team at $29 a month', () => {
    expect(TIERS.pro.price).toBe(900)
    expect(TIERS.team.price).toBe(2900)
    expect(TIERS.free.price).toBe(0)
  })

  it('treats anything unrecognised as free', () => {
    expect(tierOf('pro')).toBe('pro')
    expect(tierOf('team')).toBe('team')
    expect(tierOf('enterprise')).toBe('free')
    expect(tierOf(null)).toBe('free')
    expect(tierOf(undefined)).toBe('free')
  })

  it('gates the perks on the paid tiers only', () => {
    expect(tierDefinition('free').privatePackages).toBe(false)
    expect(tierDefinition('pro').privatePackages).toBe(true)
    expect(tierDefinition('free').priorityBuilds).toBe(false)
    expect(tierDefinition('team').priorityBuilds).toBe(true)
    expect(tierDefinition('free').maxArtifactBytes).toBeLessThan(tierDefinition('pro').maxArtifactBytes)
    expect(tierDefinition('pro').maxArtifactBytes).toBeLessThan(tierDefinition('team').maxArtifactBytes)
    expect(tierDefinition('team').seats).toBeGreaterThan(tierDefinition('pro').seats)
  })
})

describe('effectiveTier', () => {
  it('grants the tier while the subscription is live', () => {
    expect(effectiveTier({ tier: 'pro', status: 'active' })).toBe('pro')
    expect(effectiveTier({ tier: 'team', status: 'trialing' })).toBe('team')
  })

  it('keeps benefits through a failed payment', () => {
    // A card that fails at 3am must not take someone's private packages
    // offline before Stripe has finished retrying it.
    expect(effectiveTier({ tier: 'pro', status: 'past_due' })).toBe('pro')
  })

  it('honours a cancelled subscription until the paid period ends', () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    expect(effectiveTier({ tier: 'pro', status: 'canceled', currentPeriodEnd: future })).toBe('pro')
    expect(effectiveTier({ tier: 'pro', status: 'canceled', currentPeriodEnd: past })).toBe('free')
    expect(effectiveTier({ tier: 'pro', status: 'canceled' })).toBe('free')
  })

  it('falls back to free for anything else', () => {
    expect(effectiveTier(null)).toBe('free')
    expect(effectiveTier({ tier: 'pro', status: 'incomplete' })).toBe('free')
    expect(effectiveTier({ tier: 'free', status: 'active' })).toBe('free')
  })
})

describe('calculateFee', () => {
  it('takes 10% from a free seller', () => {
    const fee = calculateFee({ amount: 1000, sellerTier: 'free', discoveredOnSite: false })
    expect(fee.applicationFee).toBe(100)
    expect(fee.sellerNet).toBe(900)
    expect(fee.totalBps).toBe(1000)
  })

  it('takes 5% from a subscriber', () => {
    const fee = calculateFee({ amount: 1000, sellerTier: 'pro', discoveredOnSite: false })
    expect(fee.applicationFee).toBe(50)
    expect(fee.sellerNet).toBe(950)
  })

  it('adds 3% when the sale came from the site', () => {
    const pro = calculateFee({ amount: 1000, sellerTier: 'pro', discoveredOnSite: true })
    expect(pro.discoveryBps).toBe(DISCOVERY_FEE_BPS)
    expect(pro.totalBps).toBe(800)
    expect(pro.applicationFee).toBe(80)

    const free = calculateFee({ amount: 1000, sellerTier: 'free', discoveredOnSite: true })
    expect(free.totalBps).toBe(1300)
    expect(free.applicationFee).toBe(130)
  })

  it('never charges the buyer the fee — it comes out of the seller', () => {
    const fee = calculateFee({ amount: 900, sellerTier: 'free', discoveredOnSite: true })
    expect(fee.amount).toBe(900)
    expect(fee.applicationFee + fee.sellerNet).toBe(900)
  })

  it('rounds in the seller\'s favour', () => {
    // 5% of 999 is 49.95 cents. The half-cent goes to them.
    const fee = calculateFee({ amount: 999, sellerTier: 'pro', discoveredOnSite: false })
    expect(fee.applicationFee).toBe(49)
    expect(fee.sellerNet).toBe(950)
  })

  it('stays sane at the edges', () => {
    expect(calculateFee({ amount: 1, sellerTier: 'free', discoveredOnSite: true }).applicationFee).toBe(0)
    // A $10,000 sale from a free seller, discovered on the site: 13% of it.
    const big = calculateFee({ amount: 1_000_000, sellerTier: 'free', discoveredOnSite: true })
    expect(big.applicationFee).toBe(130_000)
    expect(big.sellerNet).toBe(870_000)
  })
})

describe('display', () => {
  it('formats basis points as percentages', () => {
    expect(formatBps(500)).toBe('5%')
    expect(formatBps(1000)).toBe('10%')
    expect(formatBps(1300)).toBe('13%')
    expect(formatBps(250)).toBe('2.50%')
  })

  it('counts only site sales as discovery', () => {
    expect(isDiscovery('site')).toBe(true)
    expect(isDiscovery('cli')).toBe(false)
    expect(isDiscovery('api')).toBe(false)
  })
})
