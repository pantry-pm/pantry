import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as http from 'node:http'
import * as nodeHttps from 'node:https'

// Captured before the mock is installed, so it can be put back afterwards:
// a module mock outlives the file that registered it, and every later test
// file in this process shares the registry.
const realHttps = { ...nodeHttps }

// Every https request fails with the status a shared-IP CI runner actually
// gets from unauthenticated api.github.com once the 60 req/hr quota is gone.
// A 403 is deliberately non-retryable, so this resolves at once.
function rateLimitedRequest(): EventEmitter & { destroy: () => void } {
  const req = Object.assign(new EventEmitter(), { destroy: () => {} })
  setImmediate(() => req.emit('error', Object.assign(
    new Error('HTTP 403 fetching https://api.github.com/repos/oven-sh/bun/releases?per_page=100'),
    { statusCode: 403 },
  )))
  return req
}

mock.module('node:https', () => ({ get: rateLimitedRequest, default: { get: rateLimitedRequest } }))

const { resolveInstallerVersionConstraint } = await import('../src/installer')

// A version no bundled catalog can contain, so resolving it proves the
// registry was consulted rather than the point-in-time snapshot.
const METADATA = {
  versions: {
    '99.1.0': { platforms: { 'darwin-arm64': { tarball: 'binaries/bun.com/99.1.0/darwin-arm64/bun.com-99.1.0.tar.gz' } } },
    '99.1.1': { platforms: { 'darwin-arm64': { tarball: 'binaries/bun.com/99.1.1/darwin-arm64/bun.com-99.1.1.tar.gz' } } },
    '99.2.0': { platforms: { 'linux-x86-64': { tarball: 'binaries/bun.com/99.2.0/linux-x86-64/bun.com-99.2.0.tar.gz' } } },
  },
}

let server: http.Server
let serveMetadata = true
const previousRegistry = process.env.PANTRY_REGISTRY_URL

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    if (!serveMetadata) {
      res.writeHead(403).end('rate limited')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(METADATA))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  // http, so these calls go through the un-mocked `node:http` while the bun
  // releases lookup stays dead.
  process.env.PANTRY_REGISTRY_URL = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  mock.module('node:https', () => realHttps)
  if (previousRegistry === undefined) delete process.env.PANTRY_REGISTRY_URL
  else process.env.PANTRY_REGISTRY_URL = previousRegistry
  await new Promise<void>(resolve => server.close(() => resolve()))
})

const darwinArm64 = { os: 'darwin', arch: 'aarch64' } as const

describe('version resolution with a degraded live source', () => {
  it('falls back to the registry when the bun releases lookup is rate-limited', async () => {
    // The reported failure: `^1.4.1` rejected as unsatisfiable while 1.4.2 was
    // published. The pin here can only come from the registry.
    expect(await resolveInstallerVersionConstraint('bun.com', '^99.1.1', darwinArm64, { quiet: true })).toBe('99.1.1')
    expect(await resolveInstallerVersionConstraint('bun.sh', '^99.1.0', darwinArm64, { quiet: true })).toBe('99.1.1')
  })

  it('honours the platform the registry publishes for', async () => {
    // 99.2.0 is linux-only, so a darwin runner must not be handed it.
    expect(await resolveInstallerVersionConstraint('bun.com', '^99.1.0', darwinArm64, { quiet: true })).toBe('99.1.1')
    expect(await resolveInstallerVersionConstraint('bun.com', '^99.2.0', { os: 'linux', arch: 'x86_64' }, { quiet: true })).toBe('99.2.0')
  })

  it('names both failed sources when no source could be consulted', async () => {
    serveMetadata = false
    try {
      await resolveInstallerVersionConstraint('bun.com', '^99.1.1', darwinArm64, { quiet: true })
      throw new Error('expected an unsatisfiable-constraint failure')
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('No version of bun.com satisfies "^99.1.1".')
      expect(message).toContain('2 of 3 version sources could not be consulted')
      expect(message).toContain('api.github.com/repos/oven-sh/bun/releases: unavailable')
      expect(message).toContain('/binaries/bun.com (darwin-arm64): unavailable')
      // The bundled snapshot answered, and the message says so rather than
      // presenting its ceiling as the whole truth.
      expect(message).toContain('bundled catalog (this pantry build):')
    }
    finally {
      serveMetadata = true
    }
  })
})
