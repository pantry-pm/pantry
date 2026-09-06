import { afterEach, describe, expect, test } from 'bun:test'
import { pkgxHasPrebuilt } from './build-all-packages'

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
    }) as typeof fetch

    expect(await pkgxHasPrebuilt('cmake.org', '4.4.3', 'darwin-arm64')).toBe(true)
    expect(seen!.method).toBe('HEAD')
    expect(seen!.url).toBe('https://dist.pkgx.dev/cmake.org/darwin/aarch64/v4.4.3.tar.xz')
  })

  test('reports a 404 as not present', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch
    expect(await pkgxHasPrebuilt('redis.io', '8.10.1', 'darwin-arm64')).toBe(false)
  })

  // The whole point of the helper is to let a caller SKIP work, so an
  // inconclusive answer has to mean "do the work anyway". A probe that
  // reported `true` on a network blip would silently drop an artifact.
  test('fails closed when the probe itself fails', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNRESET') }) as typeof fetch
    expect(await pkgxHasPrebuilt('cmake.org', '4.4.3', 'darwin-arm64')).toBe(false)
  })

  test('fails closed for a platform pkgx has no dist path for', async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response(null, { status: 200 }) }) as typeof fetch
    expect(await pkgxHasPrebuilt('cmake.org', '4.4.3', 'windows-x86-64')).toBe(false)
    expect(called).toBe(false)
  })
})
