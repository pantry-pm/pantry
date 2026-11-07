import { afterEach, describe, expect, test } from 'bun:test'
import { recipe as claudeDesktop } from '../src/recipes/apps/claude.ai'
import { discoverRecipes, hasPublishedArtifact, latestRecipeVersion, planEntry, publicationTargets, publishPlan, commitSubject, latestGithub, needsMacos } from './check-desktop-updates'

import { findRecipeFile, loadRecipe } from './recipe-loader'

describe('desktop update flow', () => {
  test('routes disk images to a native macOS runner', () => {
    expect(needsMacos({ build: { script: ['hdiutil attach app.dmg'] } })).toBe(true)
    expect(needsMacos({ build: { script: ['curl app.zip', 'unzip app.zip'] } })).toBe(false)
  })

  test('routes Claude ZIP updates to macOS for native signature and Gatekeeper verification', () => {
    expect(needsMacos(claudeDesktop)).toBe(true)
    expect(needsMacos({ build: { script: ['codesign --verify App.app'] } })).toBe(true)
    expect(needsMacos({ build: { script: ['spctl --assess App.app'] } })).toBe(true)
    expect(needsMacos({ build: { script: ['curl app.zip', 'unzip app.zip'] } })).toBe(false)
  })

  test('describes registry-backed changes as published', () => {
    const entry = {
      domain: 'example.com',
      name: 'Example',
      kind: 'app' as const,
      repo: null,
      latest: '2.0.0',
      published: '2.0.0',
      previousPublished: '1.0.0',
      needsUpdate: false,
      host: 'ubuntu' as const,
    }

    expect(commitSubject([entry])).toBe('chore(desktop): publish app Example 1.0.0 → 2.0.0')
    expect(commitSubject([{ ...entry, previousPublished: null }])).toBe('chore(desktop): publish app Example 2.0.0')
    expect(commitSubject([{ ...entry, name: '  ' }])).toBe('chore(desktop): publish app example.com 1.0.0 → 2.0.0')
    expect(commitSubject([entry, { ...entry, domain: 'font.example', name: 'Font', kind: 'font' }])).toBe('chore(desktop): publish 1 app & 1 font (Example, Font)')
  })
})

describe('latestGithub', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** Stub the two endpoints latestGithub can reach. */
  function stubGithub(latest: unknown, list: unknown[] = []) {
    const calls: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url)
      calls.push(href)
      const body = href.includes('/releases/latest') ? latest : list
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    return calls
  }

  test('takes the latest release when it ships something installable', async () => {
    const calls = stubGithub({ tag_name: 'v10.5.0', assets: [{ name: 'fd-v10.5.0-x86_64.tar.gz' }] })

    expect(await latestGithub('sharkdp/fd')).toBe('10.5.0')
    // No reason to page the release list when the latest already qualifies.
    expect(calls.some(c => c.includes('per_page'))).toBe(false)
  })

  test('includes newer prereleases only when the recipe opts in', async () => {
    stubGithub({ tag_name: 'v1.0.0', assets: [] }, [
      { tag_name: 'v1.0.0', assets: [] },
      { tag_name: 'v2.0.0-rc.1', prerelease: true, assets: [] },
    ])
    expect(await latestGithub('example/app', undefined, false)).toBe('2.0.0-rc.1')
  })

  test('checks the release list when GitHub has no latest stable release', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => String(url).includes('/releases/latest')
      ? new Response('{}', { status: 404 })
      : Response.json([{ tag_name: 'v1.0.0-rc.1', prerelease: true, assets: [] }])) as typeof fetch
    expect(await latestGithub('example/app', undefined, false)).toBe('1.0.0-rc.1')
    expect(await latestGithub('example/app')).toBeNull()
  })

  test('steps back past a release whose only assets are mobile builds', async () => {
    // Obsidian's v1.13.8 is Android-only; the newest desktop build is v1.13.7.
    stubGithub(
      { tag_name: 'v1.13.8', assets: [{ name: 'Obsidian-1.13.8.apk' }] },
      [
        { tag_name: 'v1.13.8', assets: [{ name: 'Obsidian-1.13.8.apk' }] },
        { tag_name: 'v1.13.7', assets: [{ name: 'Obsidian-1.13.7.apk' }, { name: 'Obsidian-1.13.7.dmg' }] },
      ],
    )

    expect(await latestGithub('obsidianmd/obsidian-releases')).toBe('1.13.7')
  })

  test('keeps the latest tag for a repo that attaches no assets at all', async () => {
    // VS Code tags on GitHub and ships installers from its own CDN. Stepping
    // back here would land on whichever ancient release still has a file.
    stubGithub(
      { tag_name: '1.136.1', assets: [] },
      [
        { tag_name: '1.136.1', assets: [] },
        { tag_name: 'v0.45.1', assets: [{ name: 'VSCode-osx.zip' }] },
      ],
    )

    expect(await latestGithub('microsoft/vscode')).toBe('1.136.1')
  })

  test('ignores drafts and prereleases when stepping back', async () => {
    stubGithub(
      { tag_name: 'v3.0.0', assets: [{ name: 'app-3.0.0.apk' }] },
      [
        { tag_name: 'v3.0.0', assets: [{ name: 'app-3.0.0.apk' }] },
        { tag_name: 'v2.9.0', draft: true, assets: [{ name: 'app-2.9.0.dmg' }] },
        { tag_name: 'v2.8.0', prerelease: true, assets: [{ name: 'app-2.8.0.dmg' }] },
        { tag_name: 'v2.7.0', assets: [{ name: 'app-2.7.0.dmg' }] },
      ],
    )

    expect(await latestGithub('example/app')).toBe('2.7.0')
  })
})

describe('catalog-wide publication contracts', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  test('discovers every catalog app, including slash-domains and the separate Bitwarden app', async () => {
    const entries = await discoverRecipes()
    for (const { recipe, kind } of entries) {
      expect(recipe.versionSource, recipe.domain).toBeDefined()
      expect(publicationTargets(recipe).length, recipe.domain).toBeGreaterThan(0)
      if (kind === 'app') expect((await loadRecipe(recipe.domain)).desktopApp, recipe.domain).toBe(true)
    }
    const domains = entries.map(({ recipe }) => recipe.domain)
    expect(domains).toContain('docker.com/desktop')
    expect(domains).toContain('github.com/desktop')
    expect(domains).toContain('github.com/stacksjs/launchpad')
    expect(domains).toContain('bitwarden.com/desktop')
    expect(domains).toContain('gpt4all.io')
    expect(domains).not.toContain('github.com/nomic-ai/gpt4all')
    expect((await loadRecipe('gpt4all.io')).recipe.programs).toEqual([])
    expect((await loadRecipe('github.com/nomic-ai/gpt4all')).desktopApp).toBe(false)
    expect(domains).not.toContain('bitwarden.com')
    expect((await loadRecipe('bitwarden.com/desktop')).recipe.programs).toEqual([])
    expect((await loadRecipe('docker.com/desktop')).recipe.programs).toEqual(['docker-desktop'])
    expect((await loadRecipe('bitwarden.com')).desktopApp).toBe(false)
    expect(findRecipeFile('unknown.example/desktop')).toBeNull()
  })

  test('preserves vendor app signatures without changing CLI fixups', async () => {
    for (const domain of ['github.com/desktop', 'claude.ai', 'bitwarden.com/desktop', 'github.com/stacksjs/launchpad']) {
      expect((await loadRecipe(domain)).recipe.build?.skip).toContain('fix-machos')
    }
    expect((await loadRecipe('bitwarden.com')).recipe.build?.skip ?? []).not.toContain('fix-machos')
  })

  test('publishes an archive for its actual target, excludes retired Intel and never labels Mac bytes as Linux', () => {
    expect(publicationTargets({ ...claudeDesktop, platforms: ['darwin/aarch64', 'darwin/x86-64', 'windows/x64'] })).toEqual([{ platform: 'darwin-arm64', host: 'macos' }])
    expect(publicationTargets({ ...claudeDesktop, build: { script: ['unzip app.zip'] }, platforms: ['darwin/aarch64', 'linux/x86-64'] })).toEqual([
      { platform: 'darwin-arm64', host: 'ubuntu' }, { platform: 'linux-x86-64', host: 'ubuntu' },
    ])
    expect(() => publicationTargets({ ...claudeDesktop, platforms: ['windows/x64'] })).toThrow('no maintained')
  })

  test('a latestVersion without the required scanned target is not current', async () => {
    const recipe = { ...claudeDesktop, versionSource: { type: 'custom' as const, fetch: async () => ['4.23118.0'] } }
    const incomplete = { ...publishedFixture(), versions: { '4.23118.0': { platforms: { 'linux-x86-64': artifactFixture() } } } }
    const entry = await planEntry(recipe, 'app', undefined, incomplete)
    expect(entry.needsUpdate).toBe(true)
    expect(entry.pendingTargets).toEqual([{ platform: 'darwin-arm64', host: 'macos' }])
    expect((await planEntry(recipe, 'app', undefined, publishedFixture())).needsUpdate).toBe(false)
    for (const artifact of [{ ...artifactFixture(), sha256: 'bad' }, { ...artifactFixture(), size: 0 }, { ...artifactFixture(), malwareScan: { verdict: 'clean', artifactSha256: 'b'.repeat(64) } }, { ...artifactFixture(), malwareScan: { verdict: 'pending' } }]) {
      expect(hasPublishedArtifact({ versions: { '4.23118.0': { platforms: { 'darwin-arm64': artifact } } } }, '4.23118.0', 'darwin-arm64')).toBe(false)
    }
  })

  test('failed and empty upstream responses remain visible failures instead of current entries', async () => {
    for (const fetch of [async () => [], async () => { throw new Error('vendor unavailable') }]) {
      const entry = await planEntry({ ...claudeDesktop, versionSource: { type: 'custom', fetch } }, 'app', undefined, publishedFixture())
      expect(entry.error).toBeDefined()
      expect(entry.latest).toBeNull()
    }
    await expect(latestRecipeVersion(undefined)).rejects.toThrow('No live version source')
    expect(await latestRecipeVersion({ type: 'url-pattern', url: 'https://vendor.example', knownVersions: ['1.9', '1.10'] })).toBe('1.10')
    expect(await latestRecipeVersion({ type: 'custom', fetch: async () => ['1.9', '1.10', 'not-a-version'] })).toBe('1.10')
  })

  test('honors product tag patterns instead of falling back to another product or checksum assets', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => Response.json(String(url).includes('/latest')
      ? { tag_name: 'browser-v9.0', assets: [{ name: 'browser.zip' }] }
      : [{ tag_name: 'browser-v9.0', assets: [{ name: 'browser.zip' }] }, { tag_name: 'desktop-v3.0', assets: [{ name: 'app.apk' }, { name: 'SHA256SUMS' }] }, { tag_name: 'desktop-v2.9', assets: [{ name: 'app.dmg' }] }])) as unknown as typeof fetch
    expect(await latestGithub('vendor/monorepo', /^desktop-v([\d.]+)$/)).toBe('2.9')
    globalThis.fetch = (async () => new Response('rate limit', { status: 429 })) as unknown as typeof fetch
    await expect(latestGithub('vendor/app')).rejects.toThrow('HTTP 429')
  })

  test('checks rolling archive fingerprints cheaply and only queues native work after a change', async () => {
    const source = { type: 'desktop-bundle' as const, url: 'https://vendor.example/app.dmg', bundle: 'App.app', format: 'dmg' as const }
    const calls: RequestInit[] = []
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => { calls.push(init); return new Response(null, { headers: { etag: 'release-a', 'content-length': '100' } }) }) as unknown as typeof fetch
    const recipe = { ...claudeDesktop, versionSource: source }
    const first = await planEntry(recipe, 'app', undefined, publishedFixture())
    expect(first.needsUpdate).toBe(true)
    expect(first.latest).toBeNull()
    const unchanged = await planEntry(recipe, 'app', { ...first, latest: '4.23118.0' }, publishedFixture())
    expect(unchanged.needsUpdate).toBe(false)
    expect(calls.every(call => call.method === 'HEAD')).toBe(true)
    globalThis.fetch = (async () => new Response(null)) as unknown as typeof fetch
    expect((await planEntry(recipe, 'app', undefined, null)).error).toContain('fingerprint')
  })

  test('publishes and verifies the frozen version for every target while continuing after a failed package', async () => {
    const effects: string[] = []
    const target = { platform: 'darwin-arm64', host: 'ubuntu' as const }
    const base = { domain: 'first.example', name: 'First', kind: 'app' as const, repo: null, host: 'ubuntu' as const, latest: '2.0', published: '1.0', needsUpdate: true, pendingTargets: [target], targets: [target] }
    const result = await publishPlan([base, { ...base, domain: 'second.example', latest: null, pendingTargets: [{ ...target, host: 'macos' }] }], 'all', {
      resolveBundle: async () => '3.0',
      publish: async (entry, target) => { effects.push(`publish:${entry.domain}@${entry.latest}:${target.platform}`); if (entry.domain === base.domain) throw new Error('scan refused') },
      verify: async entry => { effects.push(`verify:${entry.domain}@${entry.latest}`) },
    })
    expect(result.failures).toEqual(['first.example: Error: scan refused'])
    expect(result.packages.map(entry => [entry.domain, entry.latest])).toEqual([['second.example', '3.0']])
    expect(effects).toEqual(['publish:first.example@2.0:darwin-arm64', 'publish:second.example@3.0:darwin-arm64', 'verify:second.example@3.0'])
    const ubuntu = await publishPlan([{ ...base, pendingTargets: [{ ...target, host: 'macos' }] }], 'ubuntu', { resolveBundle: async () => { throw new Error('wrong host') }, publish: async () => { throw new Error('wrong host') }, verify: async () => {} })
    expect(ubuntu.packages).toEqual([])
    expect(ubuntu.failures).toEqual([])
  })
})

function artifactFixture() {
  return { tarball: 'binaries/claude.ai/app.tar.gz', sha256: 'a'.repeat(64), size: 100, malwareScan: { verdict: 'clean', artifactSha256: 'a'.repeat(64) } }
}
function publishedFixture() {
  return { latestVersion: '4.23118.0', versions: { '4.23118.0': { platforms: { 'darwin-arm64': artifactFixture() } } } }
}

import { appcastVersionSource, jsonVersionSource, redirectVersionSource, textVersionSource } from './desktop-version-sources'
import { desktopVersionMatches } from './desktop-artifacts'

describe('vendor metadata parsers and installed versions', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  test('Sparkle prefers marketing versions over internal build numbers and supports old feeds', async () => {
    globalThis.fetch = (async () => new Response('<rss><item><enclosure sparkle:version="99999" sparkle:shortVersionString="2.1"/></item><item><sparkle:shortVersionString>2.0</sparkle:shortVersionString></item><item><enclosure sparkle:version="1.9"/></item></rss>')) as unknown as typeof fetch
    expect(await appcastVersionSource('https://vendor.example/feed').fetch()).toEqual(['2.1', '2.0', '1.9'])
  })
  test('text parsers preserve multiline matching, reject empty/malformed feeds and non-OK status', async () => {
    globalThis.fetch = (async () => new Response('release metadata\nversion: 3.1\n')) as unknown as typeof fetch
    expect(await textVersionSource('https://vendor.example/feed', /^version: ([\d.]+)/m).fetch()).toEqual(['3.1'])
    globalThis.fetch = (async () => new Response('{}')) as unknown as typeof fetch
    await expect(jsonVersionSource('https://vendor.example/feed', data => [data.version]).fetch()).rejects.toThrow('No desktop versions')
    globalThis.fetch = (async () => new Response('missing', { status: 404 })) as unknown as typeof fetch
    await expect(appcastVersionSource('https://vendor.example/feed').fetch()).rejects.toThrow('HTTP 404')
  })
  test('redirect discovery releases the installer body instead of downloading it', async () => {
    let cancelled = false
    globalThis.fetch = (async () => {
      const response = new Response(new ReadableStream({ cancel() { cancelled = true } }))
      Object.defineProperty(response, 'url', { value: 'https://vendor.example/releases/App-3.1.zip' })
      return response
    }) as unknown as typeof fetch
    expect(await redirectVersionSource('https://vendor.example/latest', /App-([\d.]+)\.zip/).fetch()).toEqual(['3.1'])
    expect(cancelled).toBe(true)
  })
  test('refuses rolling installers whose real bundle version differs from the requested version', () => {
    expect(desktopVersionMatches('2.1.0', '2.1.0', '900')).toBe(true)
    expect(desktopVersionMatches('2.1.0-r123', '2.1.0', '900')).toBe(true)
    expect(desktopVersionMatches('2.1.0', '2.2.0', '901')).toBe(false)
    expect(desktopVersionMatches('2.1.0', '2.1.01', '900')).toBe(false)
  })
})
