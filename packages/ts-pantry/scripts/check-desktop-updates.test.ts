import { afterEach, describe, expect, test } from 'bun:test'
import { commitSubject, latestGithub, needsMacos } from './check-desktop-updates'

describe('desktop update flow', () => {
  test('routes disk images to a native macOS runner', () => {
    expect(needsMacos({ build: { script: ['hdiutil attach app.dmg'] } })).toBe(true)
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

    expect(commitSubject([entry])).toBe('chore(desktop): publish app example.com 1.0.0 → 2.0.0')
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
    }) as typeof fetch
    return calls
  }

  test('takes the latest release when it ships something installable', async () => {
    const calls = stubGithub({ tag_name: 'v10.5.0', assets: [{ name: 'fd-v10.5.0-x86_64.tar.gz' }] })

    expect(await latestGithub('sharkdp/fd')).toBe('10.5.0')
    // No reason to page the release list when the latest already qualifies.
    expect(calls.some(c => c.includes('per_page'))).toBe(false)
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
