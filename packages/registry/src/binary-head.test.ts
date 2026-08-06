import type { BinaryStorage } from './server'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createLocalRegistry } from './registry'
import { createServer } from './server'
import { getAvailablePort } from './test-utils'

/** Binary storage stub so /binaries/... has something real to serve. */
class MockBinaryStorage implements BinaryStorage {
  private files = new Map<string, Buffer>()

  put(key: string, data: Buffer | string): void {
    this.files.set(key, typeof data === 'string' ? Buffer.from(data) : data)
  }

  async getObject(key: string): Promise<Buffer> {
    const data = this.files.get(key)
    if (!data) throw new Error(`Not found: ${key}`)
    return data
  }
}

describe('binary proxy HEAD', () => {
  let baseUrl: string
  let server: ReturnType<typeof createServer>

  beforeEach(async () => {
    const port = await getAvailablePort()
    baseUrl = `http://localhost:${port}`
    const binaries = new MockBinaryStorage()
    binaries.put('binaries/curl.se/metadata.json', JSON.stringify({ name: 'curl.se', versions: {} }))
    server = createServer(createLocalRegistry(baseUrl), port, undefined, undefined, binaries)
    server.start()
  })

  afterEach(() => {
    server.stop()
  })

  it('answers HEAD with the GET headers and no body', async () => {
    const head = await fetch(`${baseUrl}/binaries/curl.se/metadata.json`, { method: 'HEAD' })
    const get = await fetch(`${baseUrl}/binaries/curl.se/metadata.json`)

    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'))
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'))
    expect(head.headers.get('cache-control')).toBe(get.headers.get('cache-control'))
    expect(await head.text()).toBe('')
  })

  it('still reports a missing object on HEAD', async () => {
    const res = await fetch(`${baseUrl}/binaries/curl.se/does-not-exist/metadata.json`, { method: 'HEAD' })
    expect(res.status).toBe(404)
  })

  it('rejects methods that are neither GET nor HEAD', async () => {
    const res = await fetch(`${baseUrl}/binaries/curl.se/metadata.json`, { method: 'DELETE' })
    expect(res.status).toBe(405)
  })

  it('advertises HEAD in the CORS method list', async () => {
    const res = await fetch(`${baseUrl}/binaries/curl.se/metadata.json`)
    expect(res.headers.get('access-control-allow-methods')).toContain('HEAD')
  })
})
