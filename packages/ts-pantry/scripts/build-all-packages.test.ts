import { afterEach, describe, expect, test } from 'bun:test'
import { assignStripe, isAppRecipePath, isSourceUnavailableError, scriptCompiles, matchesRequestedPackage, pkgxHasPrebuilt, summariseTimings, type PackageTiming } from './build-all-packages'

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

describe('assignStripe', () => {
  const pkgs = (costs: number[]) => costs.map((c, i) => ({ domain: `d${String(i).padStart(3, '0')}.org`, cost: c }))
  const cost = (p: { cost: number }) => p.cost
  const allStripes = (list: ReturnType<typeof pkgs>, n: number) =>
    Array.from({ length: n }, (_, i) => assignStripe(list, i, n, cost))

  test('partitions exactly — every package once, none lost', () => {
    const list = pkgs([9, 1, 8, 2, 7, 3, 6, 4, 5, 10, 1, 1])
    const stripes = allStripes(list, 4)
    const seen = stripes.flat().map(p => p.domain).sort()
    expect(seen).toEqual(list.map(p => p.domain).sort())
    expect(new Set(seen).size).toBe(list.length)
  })

  // The point of the change: index-interleaving put 85% of the darwin download
  // work into two of four stripes. What matters is the WORST stripe, since the
  // run waits for it — not how evenly the rest sit.
  test('shortens the worst stripe compared with interleaving', () => {
    // Every 4th package is heavy, which is exactly the case interleaving
    // handles worst: stripe 0 collects all of them.
    const list = pkgs([100, 1, 1, 1, 100, 1, 1, 1, 100, 1, 1, 1])
    const total = (s: Array<{ cost: number }>) => s.reduce((sum, p) => sum + p.cost, 0)

    const balanced = Math.max(...allStripes(list, 4).map(total))
    const interleaved = Math.max(...[0, 1, 2, 3].map(i => total(list.filter((_, idx) => idx % 4 === i))))

    expect(interleaved).toBe(300) // all three heavy packages land together
    expect(balanced).toBe(100) // one each; the theoretical optimum here
    expect(balanced).toBeLessThan(interleaved)
  })

  test('spreads an evenly-weighted set evenly', () => {
    const list = pkgs(Array.from({ length: 40 }, () => 5))
    const loads = allStripes(list, 4).map(s => s.reduce((sum, p) => sum + p.cost, 0))
    expect(Math.max(...loads) - Math.min(...loads)).toBe(0)
  })

  // Each stripe computes the whole assignment independently, so they must agree.
  test('is deterministic regardless of input order', () => {
    const list = pkgs([5, 5, 5, 5, 3, 3, 3, 3])
    const shuffled = [...list].reverse()
    expect(assignStripe(list, 1, 3, cost).map(p => p.domain).sort())
      .toEqual(assignStripe(shuffled, 1, 3, cost).map(p => p.domain).sort())
  })

  test('a single stripe takes everything', () => {
    const list = pkgs([1, 2, 3])
    expect(assignStripe(list, 0, 1, cost)).toHaveLength(3)
  })

  test('preserves the caller ordering within a stripe', () => {
    const list = pkgs([1, 1, 1, 1, 1, 1])
    const s0 = assignStripe(list, 0, 2, cost).map(p => p.domain)
    expect(s0).toEqual([...s0].sort())
  })
})

describe('summariseTimings', () => {
  const ledger: PackageTiming[] = [
    { key: 'solr.apache.org@9.9.0', domain: 'solr.apache.org', version: '9.9.0', platform: 'darwin-arm64', status: 'failed' as const, totalMs: 73.8 * 60_000, phases: { package: 60_000, upload: 73 * 60_000 } },
    { key: 'solr.apache.org@9.10.0', domain: 'solr.apache.org', version: '9.10.0', platform: 'darwin-arm64', status: 'failed' as const, totalMs: 73.8 * 60_000, phases: { package: 60_000, upload: 73 * 60_000 } },
    { key: 'bun.sh@1.3.14', domain: 'bun.sh', version: '1.3.14', platform: 'darwin-arm64', status: 'uploaded' as const, totalMs: 90_000, phases: { mirror: 40_000, upload: 45_000 } },
    { key: 'jq.dev@1.8.1', domain: 'jq.dev', version: '1.8.1', platform: 'darwin-arm64', status: 'skipped' as const, totalMs: 300, phases: { exists: 250 } },
  ]

  test('ranks by wall clock so the cost driver is the first line, not an inference', () => {
    const { console: text } = summariseTimings(ledger, 176 * 60_000, 3)
    const slowest = text.split('\n').filter(line => line.includes('min  '))
    expect(slowest).toHaveLength(3)
    expect(slowest[0]).toContain('solr.apache.org@9.9.0')
    expect(slowest[2]).toContain('bun.sh@1.3.14')
    // Phases under a second are noise; the ones that cost minutes are named.
    expect(slowest[0]).toContain('upload 4380s')
  })

  test('reports how much of the wall clock the packages account for', () => {
    // The unexplained remainder is the signal: a stripe reporting 15 seconds of
    // timed work across 176 minutes is a measurement gap, not a fast stripe.
    const { console: text } = summariseTimings(ledger, 176 * 60_000)
    expect(text).toContain('Wall clock: 176.0 min')
    expect(text).toContain('attributed to packages: 149.1 min (85%)')
  })

  test('survives an empty run without dividing by zero', () => {
    const { console: text, markdown } = summariseTimings([], 0)
    expect(text).toContain('Wall clock: 0.0 min')
    expect(text).toContain('(—)')
    expect(markdown.join('\n')).toContain('### Timing')
  })
})

describe('isSourceUnavailableError', () => {
  test('reads the marker out of the message the child actually printed', () => {
    // The markers only ever appear in build-package.ts's OUTPUT, and the
    // rejection used to carry just the exit code — so a version whose tarball
    // 404s but which exits 1 rather than 42 was reported as a build failure
    // and counted against coverage, instead of as a phantom version.
    expect(isSourceUnavailableError({
      status: 1,
      message: 'build-package.ts exited with code 1: curl: (22) The requested URL returned error: 404',
    })).toBe(true)
    expect(isSourceUnavailableError({ status: 42, message: 'build-package.ts exited with code 42' })).toBe(true)
  })

  test('still calls a genuine compile failure a failure', () => {
    expect(isSourceUnavailableError({
      status: 1,
      message: 'build-package.ts exited with code 1: ld: symbol(s) not found for architecture arm64',
    })).toBe(false)
  })
})

describe('scriptCompiles', () => {
  // --download-only exists because a download recipe can be produced for any
  // platform from any box. That is only true while the script does not compile.
  // Detection keyed on `curl`, so ghostscript.com — which curls a SOURCE
  // tarball and then runs ./configure && make — was selected for darwin-arm64
  // on an ubuntu runner and died at "C compiler cannot create executables",
  // 23 times in one sweep.
  test('vetoes a recipe that curls source and then builds it', () => {
    const ghostscriptish = [
      "      'curl -fSL \"$GS_URL\" | tar xJ',",
      "      './configure $ARGS',",
      "      'make --jobs 4 install',",
    ].join('\n')
    expect(scriptCompiles(ghostscriptish)).toBe(true)
  })

  test('matches commands as they appear in recipe source, quoted and indented', () => {
    // The text is TypeScript source, so every command is a quoted array entry.
    // Anchoring to line start alone matched nothing at all.
    expect(scriptCompiles("      './configure --prefix=x',")).toBe(true)
    expect(scriptCompiles("      'make install',")).toBe(true)
    expect(scriptCompiles("      'cmake -B build',")).toBe(true)
    expect(scriptCompiles("      'cargo build --release',")).toBe(true)
    expect(scriptCompiles("      'go build ./cmd/x',")).toBe(true)
  })

  test('leaves a genuine download recipe alone', () => {
    const ctopish = [
      "      'case {{hw.platform}}+{{hw.arch}} in',",
      "      '  linux+aarch64)  ASSET=\"ctop-linux-arm64\" ;;',",
      "      'curl -Lfo ctop \"${BASE}/${ASSET}\"',",
      "      'install -Dm755 ctop {{prefix}}/bin/ctop',",
    ].join('\n')
    expect(scriptCompiles(ctopish)).toBe(false)
  })

  test('does not mistake mkdir or a makefile mention for a build', () => {
    expect(scriptCompiles("      'mkdir -p {{prefix}}/bin',")).toBe(false)
    expect(scriptCompiles('      // upstream ships no makefile,')).toBe(false)
  })
})

describe('isAppRecipePath', () => {
  // "App" used to mean "declares no linux platform" — a proxy that misreads a
  // GUI application shipping a linux build. gpt4all publishes a Qt Installer
  // Framework .run alongside its .dmg, so the proxy called it a CLI package and
  // the source sweep attempted it five times a run, each failing on an X11
  // library a CLI runner has no reason to carry. Location is what
  // check-desktop-updates.ts already treats as authoritative.
  test('recognises apps at any nesting depth', () => {
    expect(isAppRecipePath('apps')).toBe(true)
    expect(isAppRecipePath('apps/github.com/nomic-ai')).toBe(true)
  })

  test('does not capture unrelated prefixes that merely start with the letters', () => {
    expect(isAppRecipePath('appsflyer.com')).toBe(false)
    expect(isAppRecipePath('github.com/nomic-ai')).toBe(false)
    expect(isAppRecipePath('')).toBe(false)
  })
})
