import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { PassThrough } from 'node:stream'
import { OVERSIZED_ARCHIVE_BYTES, scanArchiveEntries, scanArchiveWithEntryFallback, writeVerifiedArtifact } from './archive-entry-scan'
import type { MalwareScanContext, MalwareScanResult } from './malware-scanning'

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('000644 \0', 100, 8, 'utf8')
  header.write('000000 \0', 108, 8, 'utf8')
  header.write('000000 \0', 116, 8, 'utf8')
  header.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'utf8')
  header.write('00000000000 ', 136, 12, 'utf8')
  header.write('        ', 148, 8, 'utf8')
  header.write('0', 156, 1, 'utf8')
  header.write('ustar\0', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return header
}

function gzipTar(files: Array<{ name: string, body: string }>): Buffer {
  const parts: Buffer[] = []
  for (const file of files) {
    const body = Buffer.from(file.body)
    parts.push(tarHeader(file.name, body.byteLength), body)
    const padding = (512 - (body.byteLength % 512)) % 512
    if (padding > 0) parts.push(Buffer.alloc(padding))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

/** Records what it was handed, so the test can assert per-MEMBER scanning. */
class EntryScanner {
  seen: number[] = []
  verdictFor: (index: number) => MalwareScanResult['verdict'] = () => 'clean'

  async scanStream(
    data: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
    _context: MalwareScanContext,
    expected: { sha256: string, size: number },
  ): Promise<MalwareScanResult> {
    let bytes = 0
    for await (const chunk of data as AsyncIterable<Uint8Array>) bytes += chunk.byteLength
    this.seen.push(bytes)
    const verdict = this.verdictFor(this.seen.length - 1)
    return {
      verdict,
      engine: 'clamav',
      engineVersion: 'ClamAV 1.5.3',
      databaseVersion: '28079',
      scannedAt: new Date().toISOString(),
      durationMs: 1,
      artifactSha256: expected.sha256,
      ...(verdict === 'blocked' ? { signature: 'Test.Member' } : {}),
      ...(verdict === 'error' ? { reason: 'member unreadable' } : {}),
    }
  }
}

describe('scanArchiveEntries', () => {
  const directories: string[] = []
  const write = (archive: Buffer) => {
    const directory = mkdtempSync(join(tmpdir(), 'pantry-entry-scan-test-'))
    directories.push(directory)
    const file = join(directory, 'artifact.tar.gz')
    writeFileSync(file, archive)
    return file
  }
  const context: MalwareScanContext = { surface: 'binary', name: 'example.com/tool', version: '1.2.3' }
  const sha = 'a'.repeat(64)

  it('hands the engine one member at a time and reports the archive digest', async () => {
    // The whole point: a member the whole-archive pass would not open is
    // scanned on its own, so coverage is greater than the pass that gave up.
    const scanner = new EntryScanner()
    const file = write(gzipTar([
      { name: 'bin/tool', body: 'x'.repeat(300) },
      { name: 'lib/big.jar', body: 'y'.repeat(1500) },
    ]))

    const result = await scanArchiveEntries(file, context, scanner, { artifactSha256: sha })

    expect(result.verdict).toBe('clean')
    expect(scanner.seen).toEqual([300, 1500])
    // The digest is the ARCHIVE's — no member has one anyone attested to.
    expect(result.artifactSha256).toBe(sha)
    expect(result.engineVersion).toBe('ClamAV 1.5.3')
  })

  it('blocks the archive when any single member is blocked', async () => {
    const scanner = new EntryScanner()
    scanner.verdictFor = index => (index === 1 ? 'blocked' : 'clean')
    const file = write(gzipTar([
      { name: 'a', body: 'clean' },
      { name: 'b', body: 'bad' },
      { name: 'c', body: 'clean' },
    ]))

    const result = await scanArchiveEntries(file, context, scanner, { artifactSha256: sha })

    expect(result.verdict).toBe('blocked')
    expect(result.signature).toBe('Test.Member')
  })

  it('fails closed when a member cannot be scanned', async () => {
    // A member the engine errored on leaves the archive uncovered, which is
    // the same state the whole-archive limit left it in.
    const scanner = new EntryScanner()
    scanner.verdictFor = () => 'error'
    const file = write(gzipTar([{ name: 'a', body: 'x' }]))

    const result = await scanArchiveEntries(file, context, scanner, { artifactSha256: sha })

    expect(result.verdict).toBe('error')
    expect(result.reason).toContain('member unreadable')
  })

  it('refuses an archive with no regular files rather than calling it clean', async () => {
    const scanner = new EntryScanner()
    const file = write(gzipTar([]))

    const result = await scanArchiveEntries(file, context, scanner, { artifactSha256: sha })

    expect(result.verdict).toBe('error')
    expect(result.reason).toContain('no regular files')
  })

  it('stops at the entry ceiling instead of unpacking without bound', async () => {
    const scanner = new EntryScanner()
    const file = write(gzipTar([
      { name: 'a', body: 'x' },
      { name: 'b', body: 'x' },
      { name: 'c', body: 'x' },
    ]))

    const result = await scanArchiveEntries(file, context, scanner, { artifactSha256: sha, maxEntries: 2 })

    expect(result.verdict).toBe('error')
    expect(result.reason).toContain('exceeded 2 entries')
  })

  it('stops at the unpacked-bytes ceiling', async () => {
    const scanner = new EntryScanner()
    const file = write(gzipTar([{ name: 'a', body: 'x'.repeat(100) }]))

    const result = await scanArchiveEntries(file, context, scanner, {
      artifactSha256: sha,
      maxUnpackedBytes: 10,
    })

    expect(result.verdict).toBe('error')
    expect(result.reason).toContain('exceeded 10 unpacked bytes')
  })

  it('reports a corrupt archive as an error, never as clean', async () => {
    const scanner = new EntryScanner()
    const file = write(Buffer.from('this is not a gzip stream'))

    const result = await scanArchiveEntries(file, context, scanner, { artifactSha256: sha })

    expect(result.verdict).toBe('error')
    expect(result.reason).toContain('archive-entry scan failed')
  })

  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  })
})

describe('writeVerifiedArtifact', () => {
  const collect = (sink: PassThrough) => {
    const chunks: Buffer[] = []
    sink.on('data', chunk => chunks.push(Buffer.from(chunk)))
    return () => Buffer.concat(chunks)
  }
  const source = (...chunks: string[]) => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield new TextEncoder().encode(chunk)
    },
  })

  it('returns the digest of what actually arrived', async () => {
    const sink = new PassThrough()
    const read = collect(sink)
    const digest = await writeVerifiedArtifact(source('hello ', 'world'), sink, 11)
    expect(read().toString()).toBe('hello world')
    expect(digest).toBe(createHash('sha256').update('hello world').digest('hex'))
  })

  it('rejects a truncated download instead of scanning a partial artifact', async () => {
    // A short read scanned and pronounced clean is the worst outcome here:
    // the verdict would be attested against bytes nobody published.
    const sink = new PassThrough()
    sink.resume()
    await expect(writeVerifiedArtifact(source('short'), sink, 99)).rejects.toThrow(/did not match its declared size/)
  })

  it('refuses a download that overruns its declared size', async () => {
    const sink = new PassThrough()
    sink.resume()
    await expect(writeVerifiedArtifact(source('far too much'), sink, 3)).rejects.toThrow(/exceeded its declared size/)
  })
})

describe('scanArchiveWithEntryFallback', () => {
  const directories: string[] = []
  const write = (files: Array<{ name: string, body: string }>) => {
    const directory = mkdtempSync(join(tmpdir(), 'pantry-fallback-test-'))
    directories.push(directory)
    const file = join(directory, 'artifact.tar.gz')
    writeFileSync(file, gzipTar(files))
    return file
  }
  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  })

  const context: MalwareScanContext = { surface: 'binary', name: 'solr.apache.org', version: '9.9.0' }
  const expected = { sha256: 'b'.repeat(64), size: 1234 }

  /**
   * Answers the whole-archive pass one way and each member another.
   *
   * Told apart by the digest, not by call order: a member is scanned with an
   * all-zero sha256 (it has none anyone attested to) while the whole-archive
   * pass carries the artifact's own. Ordering would have quietly mislabelled
   * the first member as the whole pass once the oversized path started
   * skipping that pass altogether.
   */
  class TwoPassScanner {
    calls = 0
    wholePasses = 0
    whole: MalwareScanResult
    member: MalwareScanResult['verdict'] = 'clean'
    constructor(whole: MalwareScanResult) { this.whole = whole }

    async scanStream(
      data: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
      _context: MalwareScanContext,
      request: { sha256: string, size: number },
    ): Promise<MalwareScanResult> {
      this.calls += 1
      for await (const _chunk of data as AsyncIterable<Uint8Array>) { /* drain */ }
      if (request.sha256 !== '0'.repeat(64)) {
        this.wholePasses += 1
        return this.whole
      }
      return {
        verdict: this.member,
        engine: 'clamav',
        scannedAt: new Date().toISOString(),
        durationMs: 1,
        artifactSha256: request.sha256,
      }
    }
  }

  const coverageLimit: MalwareScanResult = {
    verdict: 'error',
    engine: 'clamav',
    scannedAt: new Date().toISOString(),
    durationMs: 855417,
    artifactSha256: expected.sha256,
    reason: 'scanner coverage limit exceeded: Heuristics.Limits.Exceeded.MaxFileSize',
  }

  it('rescans member by member when the whole-archive pass ran out of coverage', async () => {
    const scanner = new TwoPassScanner(coverageLimit)
    const file = write([{ name: 'a', body: 'x' }, { name: 'b', body: 'y' }])

    const result = await scanArchiveWithEntryFallback(file, context, scanner, expected, {
      openArchive: () => createReadStream(file),
    })

    expect(result.verdict).toBe('clean')
    // One whole-archive pass, then one call per member.
    expect(scanner.calls).toBe(3)
    expect(result.artifactSha256).toBe(expected.sha256)
  })

  it('skips the whole-archive pass entirely for an oversized artifact', async () => {
    // A 2 GiB archive cannot be covered inside clamd's MaxScanTime, so the
    // first pass is a foregone Heuristics.Limits.Exceeded that costs the whole
    // budget to arrive at. Going straight to members is faster AND more
    // thorough — the same call the backfill makes for retained artifacts.
    const scanner = new TwoPassScanner({ ...coverageLimit, verdict: 'blocked', signature: 'must-not-be-used' })
    const file = write([{ name: 'a', body: 'x' }, { name: 'b', body: 'y' }])

    const result = await scanArchiveWithEntryFallback(
      file,
      context,
      scanner,
      { sha256: expected.sha256, size: OVERSIZED_ARCHIVE_BYTES },
      { openArchive: () => createReadStream(file) },
    )

    expect(result.verdict).toBe('clean')
    // Two members, and no whole-archive pass before them.
    expect(scanner.wholePasses).toBe(0)
    expect(scanner.calls).toBe(2)
  })

  it('leaves every other verdict exactly as the engine gave it', async () => {
    // A detection must not be re-litigated by a second pass, and a scanner
    // that is merely broken must not be retried into a clean verdict.
    for (const whole of [
      { ...coverageLimit, verdict: 'blocked' as const, signature: 'Test.EICAR', reason: undefined },
      { ...coverageLimit, reason: 'clamd closed the connection' },
      { ...coverageLimit, verdict: 'clean' as const, reason: undefined },
    ]) {
      const scanner = new TwoPassScanner(whole)
      const file = write([{ name: 'a', body: 'x' }])
      const result = await scanArchiveWithEntryFallback(file, context, scanner, expected, {
        openArchive: () => createReadStream(file),
      })
      expect(result).toEqual(whole)
      expect(scanner.wholePasses).toBe(1)
      expect(scanner.calls).toBe(1)
    }
  })

  it('names the engine limit that sent it down the fallback when the fallback also fails', async () => {
    const scanner = new TwoPassScanner(coverageLimit)
    scanner.member = 'error'
    const file = write([{ name: 'a', body: 'x' }])

    const result = await scanArchiveWithEntryFallback(file, context, scanner, expected, {
      openArchive: () => createReadStream(file),
    })

    expect(result.verdict).toBe('error')
    expect(result.reason).toContain('Heuristics.Limits.Exceeded.MaxFileSize')
  })

  it('blocks when a member the whole pass never opened turns out to be malware', async () => {
    // This is the case that justifies the whole mechanism: coverage the first
    // pass skipped is exactly where an undetected member would hide.
    const scanner = new TwoPassScanner(coverageLimit)
    scanner.member = 'blocked'
    const file = write([{ name: 'a', body: 'x' }])

    const result = await scanArchiveWithEntryFallback(file, context, scanner, expected, {
      openArchive: () => createReadStream(file),
    })

    expect(result.verdict).toBe('blocked')
  })
})
