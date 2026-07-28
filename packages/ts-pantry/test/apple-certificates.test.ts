import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateMacCertificateRequests } from '../src/apple-certificates'

describe('Apple certificate automation', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories)
      rmSync(directory, { recursive: true, force: true })
    directories.length = 0
  })

  test('generates private keys and valid CSRs without overwriting them', () => {
    if (!Bun.which('openssl'))
      return
    const directory = mkdtempSync(join(tmpdir(), 'pantry-apple-csr-'))
    directories.push(directory)

    const requests = generateMacCertificateRequests({
      outputDirectory: directory,
      commonName: 'Example Desktop',
    })

    expect(requests.map(request => request.type)).toEqual([
      'MAC_APP_DISTRIBUTION',
      'MAC_INSTALLER_DISTRIBUTION',
    ])
    for (const request of requests) {
      expect(existsSync(request.keyPath)).toBeTrue()
      expect(existsSync(request.csrPath)).toBeTrue()
      expect(statSync(request.keyPath).mode & 0o777).toBe(0o600)
      expect(statSync(request.csrPath).mode & 0o777).toBe(0o600)
      expect(Bun.spawnSync(['openssl', 'req', '-verify', '-noout', '-in', request.csrPath]).exitCode).toBe(0)
    }
    expect(() => generateMacCertificateRequests({
      outputDirectory: directory,
      commonName: 'Example Desktop',
    })).toThrow('refusing to replace')
  })
})
