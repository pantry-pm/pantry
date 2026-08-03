import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadFileReliably, isRetryableNetworkError, retryNetworkOperation } from '../src/installer'

const cleanupDirs: string[] = []
const cleanupServers: Server[] = []

afterEach(async () => {
  await Promise.all(cleanupServers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function listen(server: Server): Promise<string> {
  cleanupServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
  return `http://127.0.0.1:${address.port}`
}

function destination(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pantry-download-test-'))
  cleanupDirs.push(dir)
  return join(dir, 'archive.bin')
}

describe('installer network retries', () => {
  it('retries transient socket failures with bounded backoff', async () => {
    let attempts = 0
    const delays: number[] = []
    const warnings: string[] = []
    const result = await retryNetworkOperation('registry metadata', async () => {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      return 'ok'
    }, {
      maxAttempts: 4,
      retryDelayMs: 25,
      sleep: async (delay) => {
        delays.push(delay)
      },
      onRetry: warning => warnings.push(warning),
    })

    expect(result).toBe('ok')
    expect(attempts).toBe(3)
    expect(delays).toEqual([25, 50])
    expect(warnings).toHaveLength(2)
  })

  it('does not retry permanent HTTP failures', async () => {
    let attempts = 0
    await expect(retryNetworkOperation('archive', async () => {
      attempts += 1
      throw Object.assign(new Error('HTTP 404 downloading archive'), { statusCode: 404 })
    }, { sleep: async () => {} })).rejects.toThrow('HTTP 404')

    expect(attempts).toBe(1)
    expect(isRetryableNetworkError(Object.assign(new Error('HTTP 503'), { statusCode: 503 }))).toBe(true)
  })

  it('retries an interrupted response and only publishes the complete file', async () => {
    const payload = Buffer.from('complete archive bytes')
    let requests = 0
    const server = createServer((_, response) => {
      requests += 1
      response.writeHead(200, { 'Content-Length': payload.length })
      if (requests === 1) {
        response.write(payload.subarray(0, 5))
        response.socket?.destroy()
        return
      }
      response.end(payload)
    })
    const baseUrl = await listen(server)
    const dest = destination()

    await downloadFileReliably(`${baseUrl}/archive`, dest, {
      retryDelayMs: 1,
      sleep: async () => {},
      expectedSha256: createHash('sha256').update(payload).digest('hex'),
    })

    expect(requests).toBe(2)
    expect(readFileSync(dest)).toEqual(payload)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('rejects corrupted bytes after retry exhaustion without publishing them', async () => {
    const payload = Buffer.from('corrupted archive')
    let requests = 0
    const server = createServer((_, response) => {
      requests += 1
      response.writeHead(200, { 'Content-Length': payload.length })
      response.end(payload)
    })
    const baseUrl = await listen(server)
    const dest = destination()

    await expect(downloadFileReliably(`${baseUrl}/archive`, dest, {
      maxAttempts: 3,
      retryDelayMs: 1,
      sleep: async () => {},
      expectedSha256: '0'.repeat(64),
    })).rejects.toThrow('failed after 3 attempts: Checksum mismatch')

    expect(requests).toBe(3)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })
})
