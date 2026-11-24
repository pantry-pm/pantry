import { describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { augmentMetadataWithPkgx, isCustomBuildDomain, isQuarantinedFallback, runTar } from './pkgx-fallback'

describe('pkgx repackaging tar', () => {
  it('returns to the event loop while tar runs', async () => {
    const work = await mkdtemp(join(tmpdir(), 'pkgx-tar-test-'))
    try {
      const src = join(work, 'src')
      // Incompressible bytes, so gzip has real work to do.
      const payload = new Uint8Array(16 * 1024 * 1024)
      for (let i = 0; i < payload.length; i += 65_536)
        crypto.getRandomValues(payload.subarray(i, i + 65_536))
      await Bun.write(join(src, 'payload.bin'), payload)

      // A synchronous child process (the previous execSync) spends the whole
      // compression inside the call itself; an asynchronous one hands back its
      // promise at once and lets other requests run meanwhile.
      const started = performance.now()
      const pending = runTar(['-czf', join(work, 'out.tar.gz'), '-C', src, '.'])
      const inCall = performance.now() - started
      await pending
      const total = performance.now() - started

      expect(inCall).toBeLessThan(total / 4)
      expect(await readdir(work)).toContain('out.tar.gz')
    }
    finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  it('reports a failing tar with its exit code and stderr', async () => {
    const work = await mkdtemp(join(tmpdir(), 'pkgx-tar-test-'))
    try {
      const bogus = join(work, 'not-an-archive.tar.xz')
      await writeFile(bogus, 'definitely not xz')
      await expect(runTar(['-xJf', bogus, '-C', work])).rejects.toThrow(/tar -xJf exited \d+/)
    }
    finally {
      await rm(work, { recursive: true, force: true })
    }
  })
})

describe('pkgx metadata augmentation cache', () => {
  it('never falls back to pkgx for Pantry custom builds', () => {
    expect(isCustomBuildDomain('curl.se')).toBe(true)
    expect(isCustomBuildDomain('bun.com')).toBe(false)
  })

  it('invalidates cached augmentation when published metadata changes', async () => {
    const domain = `cache-refresh-${crypto.randomUUID()}.example`
    const first = await augmentMetadataWithPkgx(domain, {
      latestVersion: '1.0.0',
      updatedAt: '2026-07-19T20:00:00.000Z',
      versions: { '1.0.0': { platforms: {} } },
    }, [])
    const refreshed = await augmentMetadataWithPkgx(domain, {
      latestVersion: '2.0.0',
      updatedAt: '2026-07-19T21:00:00.000Z',
      versions: {
        '1.0.0': { platforms: {} },
        '2.0.0': { platforms: {} },
      },
    }, [])

    expect(first?.latestVersion).toBe('1.0.0')
    expect(refreshed?.latestVersion).toBe('2.0.0')
  })

  it('suppresses fallback for a durably quarantined version and platform', () => {
    const metadata = {
      malwareQuarantines: [{
        version: '2.0.1',
        platforms: ['darwin-x86-64'],
        artifactSha256: 'a'.repeat(64),
      }],
    }

    expect(isQuarantinedFallback(metadata, '2.0.1', 'darwin-x86-64')).toBe(true)
    expect(isQuarantinedFallback(metadata, '2.0.1', 'linux-x86-64')).toBe(false)
    expect(isQuarantinedFallback(metadata, '2.0.2', 'darwin-x86-64')).toBe(false)
  })
})
