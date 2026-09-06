import { afterEach, describe, expect, test } from 'bun:test'
import { matchesRequestedPackage, pkgxHasPrebuilt } from './build-all-packages'

describe('pkgxHasPrebuilt', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('confirms an artifact pkgx actually serves, without pulling the body', async () => {
    let seen: { url: string, method?: string } | null = null
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), method: init?.method }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    expect(await pkgxHasPrebuilt('cmake.org', '4.4.3', 'darwin-arm64')).toBe(true)
    expect(seen!.method).toBe('HEAD')
    expect(seen!.url).toBe('https://dist.pkgx.dev/cmake.org/darwin/aarch64/v4.4.3.tar.xz')
  })

  test('reports a 404 as not present', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch
    expect(await pkgxHasPrebuilt('redis.io', '8.10.1', 'darwin-arm64')).toBe(false)
  })

  // The whole point of the helper is to let a caller SKIP work, so an
  // inconclusive answer has to mean "do the work anyway". A probe that
  // reported `true` on a network blip would silently drop an artifact.
  test('fails closed when the probe itself fails', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    expect(await pkgxHasPrebuilt('cmake.org', '4.4.3', 'darwin-arm64')).toBe(false)
  })

  test('fails closed for a platform pkgx has no dist path for', async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response(null, { status: 200 }) }) as unknown as typeof fetch
    expect(await pkgxHasPrebuilt('cmake.org', '4.4.3', 'windows-x86-64')).toBe(false)
    expect(called).toBe(false)
  })
})

/**
 * The rule that decides whether a targeted publish goes red. Extracted here
 * because getting it wrong is expensive in both directions: too strict and the
 * pipeline is permanently red over a 2019 release nobody can fix, too loose and
 * a genuinely missing current version publishes as green — which is exactly how
 * cmake.org 4.4.3 stayed missing for eleven days.
 */
function classify(
  failed: Array<[string, { version: string }]>,
  latestOf: Map<string, string>,
  knownBroken: Set<string>,
  multiVersion = true,
) {
  const domainOf = (key: string) => (multiVersion ? key.replace(/@[^@]*$/, '') : key)
  const isNewest = ([key, result]: [string, { version: string }]) => {
    const latest = latestOf.get(domainOf(key))
    return latest === undefined || result.version === latest
  }
  const eligible = failed.filter(([key]) => !knownBroken.has(domainOf(key)))
  return { fatal: eligible.filter(isNewest), backfill: eligible.filter(e => !isNewest(e)) }
}

describe('targeted-build failure classification', () => {
  const latest = new Map([['cmake.org', '4.4.3'], ['lz4.org', '1.10.0']])

  test('a failed CURRENT version is fatal', () => {
    const { fatal, backfill } = classify([['cmake.org@4.4.3', { version: '4.4.3' }]], latest, new Set())
    expect(fatal).toHaveLength(1)
    expect(backfill).toHaveLength(0)
  })

  test('a failed OLD version is reported but tolerated', () => {
    const { fatal, backfill } = classify([['lz4.org@1.9.1', { version: '1.9.1' }]], latest, new Set())
    expect(fatal).toHaveLength(0)
    expect(backfill).toHaveLength(1)
  })

  test('one current failure among many old ones still fails the run', () => {
    const { fatal } = classify([
      ['lz4.org@1.9.1', { version: '1.9.1' }],
      ['lz4.org@1.8.3', { version: '1.8.3' }],
      ['cmake.org@4.4.3', { version: '4.4.3' }],
    ], latest, new Set())
    expect(fatal.map(([k]) => k)).toEqual(['cmake.org@4.4.3'])
  })

  test('known-broken domains are excluded from both buckets', () => {
    const { fatal, backfill } = classify(
      [['cmake.org@4.4.3', { version: '4.4.3' }]], latest, new Set(['cmake.org']),
    )
    expect(fatal).toHaveLength(0)
    expect(backfill).toHaveLength(0)
  })

  // Fail CLOSED: if we cannot tell which version is current for a domain, treat
  // the failure as fatal rather than quietly shrugging it off.
  test('an unknown domain is treated as fatal', () => {
    const { fatal } = classify([['mystery.org@1.0.0', { version: '1.0.0' }]], latest, new Set())
    expect(fatal).toHaveLength(1)
  })
})

describe('matchesRequestedPackage', () => {
  const sel = (domain: string, name: string, ...req: string[]) =>
    matchesRequestedPackage(domain, name, req)

  test('matches the domain or the name exactly', () => {
    expect(sel('cmake.org', 'cmake', 'cmake.org')).toBe(true)
    expect(sel('cmake.org', 'cmake', 'cmake')).toBe(true)
  })

  test('matches a path child, which is a real selector', () => {
    expect(sel('python.org/typing_extensions', 'typing_extensions', 'python.org')).toBe(true)
    expect(sel('apache.org/apr', 'apr', 'apache.org')).toBe(true)
  })

  // The bug this replaced: `p.domain.includes(d)` pulled unrelated packages into
  // a targeted publish, so a vim.org release could go red because macvim failed,
  // and the darwin gate could allocate a Mac for packages nobody asked about.
  test('does not match an unrelated package that merely contains the string', () => {
    expect(sel('macvim.org', 'macvim', 'vim.org')).toBe(false)
    expect(sel('lunarvim.org', 'lunarvim', 'vim.org')).toBe(false)
    expect(sel('ipython.org', 'ipython', 'python.org')).toBe(false)
  })

  test('a path child does not match a longer sibling prefix', () => {
    expect(sel('python.organisation.example', 'x', 'python.org')).toBe(false)
  })
})
