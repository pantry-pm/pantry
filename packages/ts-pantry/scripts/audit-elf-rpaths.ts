#!/usr/bin/env bun
/**
 * Audit published Linux artifacts for ELF loader paths that cannot work.
 *
 * Before 468ded425 (2026-09-04) fix-up.ts ran patchelf through a shell, which
 * expanded `$ORIGIN` to nothing: a program's `$ORIGIN/../lib` was published as
 * `/../lib` and a library's `$ORIGIN` as an empty entry. Mirrored artifacts
 * were not normalised at all until 6e7a524cc (2026-10-17). facebook.com/zstd
 * 1.5.7 is the worked example: its `zstd` carries `RPATH [/../lib]`, loads the
 * host's libzstd.so.1, and dies on the private POOL_* symbols it imports.
 *
 * This walks the registry's own package listing (`/api/packages`), reads each
 * package's `binaries/<domain>/metadata.json`, streams the selected Linux
 * tarballs through gunzip and a tar reader, and parses the dynamic section of
 * every ELF member in memory. Nothing is written to disk, so the scratch cost
 * is the members being read at once (bounded by --concurrency).
 *
 *   bun scripts/audit-elf-rpaths.ts                         # newest pre-cutoff artifact per package and platform
 *   bun scripts/audit-elf-rpaths.ts --scope all-before      # every artifact uploaded before the cutoff
 *   bun scripts/audit-elf-rpaths.ts --domain facebook.com/zstd --scope all
 *   bun scripts/audit-elf-rpaths.ts --plan                  # selection and download size only
 *   bun scripts/audit-elf-rpaths.ts --progress audit.jsonl  # resumable: rerun to continue
 *
 * Tarball requests are paced under the registry's per-client download budget
 * (--requests-per-hour, default 500 of its 600), so a full walk takes hours.
 *
 * Findings, per RPATH/RUNPATH entry:
 *   expanded-origin   starts with `/..` - `$ORIGIN` was expanded away
 *   empty             an empty entry - a bare `$ORIGIN` expanded away; glibc reads it as the working directory
 *   relative          relative without `$ORIGIN` (`../lib`, `lib`) - resolved against the working directory
 * Absolute entries are counted but not reported as broken.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

export const LINUX_PLATFORMS = ['linux-x86-64', 'linux-arm64'] as const
export type LinuxPlatform = typeof LINUX_PLATFORMS[number]
export type Scope = 'newest-before' | 'newest' | 'all-before' | 'all'

export type EntryIssue = 'expanded-origin' | 'empty' | 'relative'

export interface LoaderPathFinding {
  member: string
  tag: 'RPATH' | 'RUNPATH'
  value: string
  issues: EntryIssue[]
}

export interface ArtifactSelection {
  domain: string
  version: string
  platform: LinuxPlatform
  tarball: string
  size: number
  uploadedAt: string
  /** A newer version on the same platform, uploaded on or after the cutoff. */
  supersededBy?: string
  /** True when no version on this platform is newer: the one a range resolves to. */
  newestOnPlatform: boolean
}

export interface ArtifactResult extends ArtifactSelection {
  elfMembers: number
  findings: LoaderPathFinding[]
  absoluteEntries: number
  error?: string
}

interface PlatformMetadata { tarball?: string, sha256?: string, size?: number, uploadedAt?: string }
interface PackageMetadata { versions?: Record<string, { platforms?: Record<string, PlatformMetadata> }> }

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** What is wrong with one RPATH/RUNPATH entry, if anything. */
export function classifyLoaderPathEntry(entry: string): EntryIssue | null {
  if (entry === '') return 'empty'
  if (entry === '/..' || entry.startsWith('/../')) return 'expanded-origin'
  if (entry.startsWith('/')) return null
  // Dynamic string tokens the loader expands itself.
  if (/^\$(?:\{)?(?:ORIGIN|LIB|PLATFORM)(?:\})?(?:\/|$)/.test(entry)) return null
  return 'relative'
}

export function classifyLoaderPath(value: string): { issues: EntryIssue[], absolute: number } {
  const issues = new Set<EntryIssue>()
  let absolute = 0
  for (const entry of value.split(':')) {
    const issue = classifyLoaderPathEntry(entry)
    if (issue) issues.add(issue)
    else if (entry.startsWith('/')) absolute++
  }
  return { issues: [...issues], absolute }
}

// ---------------------------------------------------------------------------
// ELF dynamic section
// ---------------------------------------------------------------------------

const PT_LOAD = 1
const PT_DYNAMIC = 2
const DT_NULL = 0
const DT_STRTAB = 5
const DT_RPATH = 15
const DT_RUNPATH = 29

export function isElf(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x7F && bytes[1] === 0x45 && bytes[2] === 0x4C && bytes[3] === 0x46
}

/**
 * RPATH and RUNPATH strings of an ELF image, read the way the loader reads
 * them: PT_DYNAMIC for the entries, PT_LOAD to map DT_STRTAB to a file offset.
 * Null for a static image or an object without a dynamic segment.
 */
export function readElfLoaderPaths(bytes: Uint8Array): { rpath?: string, runpath?: string } | null {
  if (!isElf(bytes) || bytes.length < 52) return null
  const wide = bytes[4] === 2
  if (!wide && bytes[4] !== 1) throw new Error('unknown ELF class')
  const little = bytes[5] === 1
  if (!little && bytes[5] !== 2) throw new Error('unknown ELF byte order')
  if (wide && bytes.length < 64) throw new Error('truncated ELF header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const word = (offset: number): number => wide ? Number(view.getBigUint64(offset, little)) : view.getUint32(offset, little)
  const sword = (offset: number): number => wide ? Number(view.getBigInt64(offset, little)) : view.getInt32(offset, little)

  const phoff = word(wide ? 32 : 28)
  const phentsize = view.getUint16(wide ? 54 : 42, little)
  const phnum = view.getUint16(wide ? 56 : 44, little)
  if (phnum === 0) return null
  if (phoff + phentsize * phnum > bytes.length) throw new Error('program headers past end of file')

  const loads: Array<{ vaddr: number, offset: number, filesz: number }> = []
  let dynamic: { offset: number, filesz: number } | null = null
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize
    const type = view.getUint32(at, little)
    const offset = wide ? word(at + 8) : word(at + 4)
    const vaddr = wide ? word(at + 16) : word(at + 8)
    const filesz = wide ? word(at + 32) : word(at + 16)
    if (type === PT_LOAD) loads.push({ vaddr, offset, filesz })
    else if (type === PT_DYNAMIC) dynamic = { offset, filesz }
  }
  if (!dynamic) return null

  const entrySize = wide ? 16 : 8
  let strtab: number | undefined
  const strings: Array<{ tag: number, value: number }> = []
  const end = Math.min(dynamic.offset + dynamic.filesz, bytes.length)
  for (let at = dynamic.offset; at + entrySize <= end; at += entrySize) {
    const tag = sword(at)
    if (tag === DT_NULL) break
    const value = word(at + (wide ? 8 : 4))
    if (tag === DT_STRTAB) strtab = value
    else if (tag === DT_RPATH || tag === DT_RUNPATH) strings.push({ tag, value })
  }
  if (!strings.length) return {}
  if (strtab === undefined) throw new Error('dynamic section has loader paths but no DT_STRTAB')
  const segment = loads.find(load => strtab! >= load.vaddr && strtab! < load.vaddr + load.filesz)
  if (!segment) throw new Error('DT_STRTAB is outside every PT_LOAD segment')
  const table = strtab - segment.vaddr + segment.offset

  const read = (offset: number): string => {
    const start = table + offset
    let stop = start
    while (stop < bytes.length && bytes[stop] !== 0) stop++
    if (stop >= bytes.length) throw new Error('unterminated dynamic string')
    return new TextDecoder().decode(bytes.subarray(start, stop))
  }
  const result: { rpath?: string, runpath?: string } = {}
  for (const { tag, value } of strings) {
    if (tag === DT_RPATH) result.rpath = read(value)
    else result.runpath = read(value)
  }
  return result
}

// ---------------------------------------------------------------------------
// Streaming tar
// ---------------------------------------------------------------------------

interface ChunkSource {
  read: () => Promise<{ done: boolean, value?: Uint8Array }>
  cancel: () => Promise<void>
}

/** Exact-length reads over a byte stream. */
class ByteReader {
  private chunks: Uint8Array[] = []
  private buffered = 0
  private done = false
  constructor(private readonly reader: ChunkSource) {}

  private async fill(n: number): Promise<boolean> {
    while (this.buffered < n && !this.done) {
      const { value, done } = await this.reader.read()
      if (done) this.done = true
      else if (value?.length) {
        this.chunks.push(value)
        this.buffered += value.length
      }
    }
    return this.buffered >= n
  }

  /** Exactly `n` bytes, or null at a clean end of stream. */
  async read(n: number): Promise<Uint8Array | null> {
    if (n === 0) return new Uint8Array(0)
    if (!await this.fill(n)) {
      if (this.buffered === 0) return null
      throw new Error('unexpected end of archive')
    }
    const out = new Uint8Array(n)
    let filled = 0
    while (filled < n) {
      const head = this.chunks[0]
      const take = Math.min(head.length, n - filled)
      out.set(head.subarray(0, take), filled)
      filled += take
      if (take === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(take)
    }
    this.buffered -= n
    return out
  }

  async skip(n: number): Promise<void> {
    let left = n
    while (left > 0) {
      if (!await this.fill(1)) throw new Error('unexpected end of archive')
      const head = this.chunks[0]
      const take = Math.min(head.length, left)
      if (take === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(take)
      this.buffered -= take
      left -= take
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => {})
  }
}

function tarString(block: Uint8Array, offset: number, length: number): string {
  let end = offset
  while (end < offset + length && block[end] !== 0) end++
  return new TextDecoder().decode(block.subarray(offset, end))
}

function tarSize(block: Uint8Array): number {
  // GNU base-256 for members over 8 GiB.
  if (block[124] & 0x80) {
    let size = 0
    for (let i = 125; i < 136; i++) size = size * 256 + block[i]
    return size
  }
  const text = tarString(block, 124, 12).trim()
  return text ? Number.parseInt(text, 8) : 0
}

function paxPath(data: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(data)
  let at = 0
  while (at < text.length) {
    const space = text.indexOf(' ', at)
    if (space < 0) break
    const length = Number.parseInt(text.slice(at, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = text.slice(space + 1, at + length - 1)
    if (record.startsWith('path=')) return record.slice(5)
    at += length
  }
  return undefined
}

/**
 * Visit every regular member that starts with the ELF magic. Other members
 * are skipped without being buffered.
 */
export async function forEachElfMember(
  stream: ReadableStream<Uint8Array>,
  visit: (path: string, bytes: Uint8Array) => void,
  maxMemberBytes: number = 2 ** 31,
): Promise<void> {
  const reader = new ByteReader(stream.getReader())
  let longName: string | undefined
  try {
    while (true) {
      const block = await reader.read(512)
      if (!block || block.every(byte => byte === 0)) break
      const type = String.fromCharCode(block[156] || 0x30)
      const size = tarSize(block)
      const padded = Math.ceil(size / 512) * 512
      const prefix = tarString(block, 345, 155)
      const name = longName ?? (prefix ? `${prefix}/${tarString(block, 0, 100)}` : tarString(block, 0, 100))
      longName = undefined

      if (type === 'L' || type === 'x') {
        const data = (await reader.read(padded))!.subarray(0, size)
        longName = type === 'L' ? tarString(data, 0, data.length) : paxPath(data)
        continue
      }
      if ((type !== '0' && type !== '7') || size < 52) {
        await reader.skip(padded)
        continue
      }
      const magic = (await reader.read(4))!
      if (!isElf(magic)) {
        await reader.skip(padded - 4)
        continue
      }
      if (size > maxMemberBytes) throw new Error(`${name}: ${size} bytes is over the member limit`)
      const rest = (await reader.read(size - 4))!
      await reader.skip(padded - size)
      const bytes = new Uint8Array(size)
      bytes.set(magic)
      bytes.set(rest, 4)
      visit(name, bytes)
    }
  }
  finally {
    await reader.cancel()
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The registry budgets each client's binary downloads (600 requests and
 * 20 GiB an hour by default, packages/registry/src/binary-rate-limit.ts), and
 * a catalog walk is exactly what that limit is for. Pace tarball requests
 * under it, and wait out a 429 for as long as Retry-After says rather than
 * recording the artifact as failed.
 */
export class RequestPacer {
  private next = 0
  constructor(private readonly perHour: number) {}
  async wait(): Promise<void> {
    if (this.perHour <= 0) return
    const interval = 3_600_000 / this.perHour
    const now = Date.now()
    const at = Math.max(now, this.next)
    this.next = at + interval
    if (at > now) await Bun.sleep(at - now)
  }
}

let tarballPacer = new RequestPacer(0)

async function fetchWithRetry(url: string, attempts = 6, pace = false): Promise<Response> {
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (pace) await tarballPacer.wait()
    try {
      const response = await fetch(url)
      if (response.ok || response.status === 404) return response
      last = new Error(`HTTP ${response.status} for ${url}`)
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after')) || 300
        console.error(`  rate limited; waiting ${retryAfter}s`)
        await response.body?.cancel()
        await Bun.sleep(Math.min(retryAfter, 3600) * 1000)
        attempt-- // a rate-limit wait is not a failed attempt
        continue
      }
    }
    catch (error) {
      last = error
    }
    await Bun.sleep(500 * 2 ** attempt)
  }
  throw last
}

function numericParts(version: string): number[] {
  return version.replace(/^v/, '').split(/[.+_-]/).map(part => Number.parseInt(part, 10)).map(n => Number.isFinite(n) ? n : -1)
}

export function compareVersionStrings(a: string, b: string): number {
  const left = numericParts(a)
  const right = numericParts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff) return diff
  }
  return a.localeCompare(b)
}

/** Which artifacts of one package to audit. */
export function selectArtifacts(domain: string, metadata: PackageMetadata, scope: Scope, cutoff: Date, platforms: readonly LinuxPlatform[] = LINUX_PLATFORMS): ArtifactSelection[] {
  const selected: ArtifactSelection[] = []
  for (const platform of platforms) {
    const artifacts = Object.entries(metadata.versions ?? {})
      .map(([version, info]) => ({ version, record: info.platforms?.[platform] }))
      .filter((a): a is { version: string, record: PlatformMetadata } => !!a.record?.tarball && !!a.record.sha256 && (a.record.size ?? 1) > 0)
      .sort((a, b) => compareVersionStrings(b.version, a.version))
    if (!artifacts.length) continue
    const before = (a: { record: PlatformMetadata }): boolean => !!a.record.uploadedAt && new Date(a.record.uploadedAt) < cutoff
    const chosen = scope === 'all' ? artifacts
      : scope === 'all-before' ? artifacts.filter(before)
        : scope === 'newest' ? artifacts.slice(0, 1)
          : artifacts.filter(before).slice(0, 1)
    for (const { version, record } of chosen) {
      const newer = artifacts.filter(a => compareVersionStrings(a.version, version) > 0)
      const repaired = newer.find(a => !before(a))
      selected.push({
        domain,
        version,
        platform,
        tarball: record.tarball!,
        size: record.size ?? 0,
        uploadedAt: record.uploadedAt ?? '',
        supersededBy: repaired?.version,
        newestOnPlatform: newer.length === 0,
      })
    }
  }
  return selected
}

export async function auditArtifact(registry: string, selection: ArtifactSelection): Promise<ArtifactResult> {
  const result: ArtifactResult = { ...selection, elfMembers: 0, findings: [], absoluteEntries: 0 }
  if (!selection.tarball.endsWith('.tar.gz') && !selection.tarball.endsWith('.tgz')) {
    result.error = 'not a gzip tarball'
    return result
  }
  try {
    const response = await fetchWithRetry(`${registry}/${selection.tarball}`, 6, true)
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'))
    await forEachElfMember(stream, (member, bytes) => {
      result.elfMembers++
      let paths: ReturnType<typeof readElfLoaderPaths>
      try {
        paths = readElfLoaderPaths(bytes)
      }
      catch (error) {
        result.findings.push({ member, tag: 'RPATH', value: `<unreadable: ${(error as Error).message}>`, issues: [] })
        return
      }
      for (const [tag, value] of [['RPATH', paths?.rpath], ['RUNPATH', paths?.runpath]] as const) {
        if (value === undefined) continue
        const { issues, absolute } = classifyLoaderPath(value)
        result.absoluteEntries += absolute
        if (issues.length) result.findings.push({ member, tag, value, issues })
      }
    })
  }
  catch (error) {
    result.error = (error as Error).message
    if (/inflate|gzip|header/i.test(result.error))
      result.error = `${result.error}${await describeUnreadableArchive(registry, selection.tarball)}`
  }
  return result
}

/**
 * Why a published tarball would not inflate. Some uploads went through a text
 * decode before they were hashed: every byte over 0x7f became U+FFFD (EF BF BD),
 * the metadata checksum matches the mangled bytes, and no client can extract it.
 */
async function describeUnreadableArchive(registry: string, tarball: string): Promise<string> {
  try {
    const response = await fetch(`${registry}/${tarball}`, { headers: { Range: 'bytes=0-15' } })
    const head = new Uint8Array(await response.arrayBuffer()).subarray(0, 16)
    if (head[0] === 0x1F && head[1] === 0xEF && head[2] === 0xBF && head[3] === 0xBD)
      return ' (archive bytes were text-decoded before upload: gzip magic is 1f ef bf bd)'
    return ` (first bytes ${[...head.subarray(0, 4)].map(b => b.toString(16).padStart(2, '0')).join(' ')})`
  }
  catch {
    return ''
  }
}

async function pool<T, R>(items: readonly T[], concurrency: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index], index)
    }
  }))
  return results
}

async function listDomains(registry: string): Promise<string[]> {
  const response = await fetchWithRetry(`${registry}/api/packages`)
  if (!response.ok) throw new Error(`package listing: HTTP ${response.status}`)
  const body = await response.json() as { packages: Array<{ domain: string, published?: boolean, platforms?: Record<string, boolean> }> }
  return body.packages
    .filter(pkg => pkg.published !== false && LINUX_PLATFORMS.some(platform => pkg.platforms?.[platform]))
    .map(pkg => pkg.domain)
    .sort()
}

function formatBytes(bytes: number): string {
  return bytes > 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GiB` : `${(bytes / 2 ** 20).toFixed(1)} MiB`
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'registry': { type: 'string', default: 'https://registry.pantry.dev' },
      'cutoff': { type: 'string', default: '2026-10-17T00:00:00Z' },
      'scope': { type: 'string', default: 'newest-before' },
      'platform': { type: 'string', multiple: true },
      'domain': { type: 'string', multiple: true },
      'concurrency': { type: 'string', default: '4' },
      'out': { type: 'string' },
      'progress': { type: 'string' },
      'requests-per-hour': { type: 'string', default: '500' },
      'plan': { type: 'boolean', default: false },
    },
  })
  const registry = values.registry!.replace(/\/$/, '')
  const cutoff = new Date(values.cutoff!)
  const scope = values.scope as Scope
  if (!['newest-before', 'newest', 'all-before', 'all'].includes(scope)) throw new Error(`unknown --scope ${scope}`)
  const platforms = (values.platform?.length ? values.platform : LINUX_PLATFORMS) as LinuxPlatform[]
  const concurrency = Math.max(1, Number.parseInt(values.concurrency!, 10) || 4)
  tarballPacer = new RequestPacer(Number.parseInt(values['requests-per-hour']!, 10) || 0)

  const domains = values.domain?.length ? values.domain : await listDomains(registry)
  console.error(`Reading metadata for ${domains.length} packages...`)
  const selections = (await pool(domains, 16, async (domain) => {
    const response = await fetchWithRetry(`${registry}/binaries/${domain}/metadata.json`)
    if (!response.ok) return []
    return selectArtifacts(domain, await response.json() as PackageMetadata, scope, cutoff, platforms)
  })).flat()
  const total = selections.reduce((sum, s) => sum + s.size, 0)
  console.error(`${selections.length} artifacts selected (${scope}, cutoff ${cutoff.toISOString()}), ${formatBytes(total)} to stream`)
  if (values.plan) {
    for (const s of selections) console.log(`${s.domain}@${s.version} ${s.platform} ${s.uploadedAt} ${formatBytes(s.size)}`)
    return
  }

  // --progress appends each result as a line and, on a rerun, skips what an
  // earlier run already read without error: a full walk spans several
  // rate-limit windows.
  const key = (s: ArtifactSelection): string => `${s.domain}@${s.version} ${s.platform}`
  const prior = new Map<string, ArtifactResult>()
  if (values.progress && existsSync(values.progress)) {
    for (const line of readFileSync(values.progress, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const result = JSON.parse(line) as ArtifactResult
      if (!result.error) prior.set(key(result), result)
    }
  }
  const pending = selections.filter(s => !prior.has(key(s)))
  if (prior.size) console.error(`${selections.length - pending.length} artifacts already read in ${values.progress}`)

  let done = 0
  const fresh = await pool(pending, concurrency, async (selection) => {
    let result = await auditArtifact(registry, selection)
    // A connection dropped mid-stream is worth another read; a bad archive is not.
    for (let retry = 0; retry < 2 && result.error && !/inflate|text-decoded|not a gzip|HTTP 404/.test(result.error); retry++)
      result = await auditArtifact(registry, selection)
    done++
    const status = result.error ? `error: ${result.error}` : result.findings.some(f => f.issues.length) ? `BROKEN (${result.findings.length})` : 'ok'
    console.error(`[${done}/${pending.length}] ${selection.domain}@${selection.version} ${selection.platform}: ${status}`)
    if (values.progress) appendFileSync(values.progress, `${JSON.stringify(result)}\n`)
    return result
  })
  const results = [...selections.filter(s => prior.has(key(s))).map(s => prior.get(key(s))!), ...fresh]

  const broken = results.filter(r => r.findings.some(f => f.issues.length))
  const errors = results.filter(r => r.error)
  const brokenDomains = [...new Set(broken.map(r => r.domain))].sort()
  const exposed = broken.filter(r => r.newestOnPlatform)
  const summary = {
    generatedAt: new Date().toISOString(),
    registry,
    scope,
    cutoff: cutoff.toISOString(),
    artifacts: results.length,
    elfMembers: results.reduce((sum, r) => sum + r.elfMembers, 0),
    brokenArtifacts: broken.length,
    brokenPackages: brokenDomains.length,
    brokenAndNewestOnPlatform: exposed.length,
    errors: errors.length,
    textDecodedArchives: errors.filter(r => r.error?.includes('text-decoded')).length,
    issueCounts: Object.fromEntries((['expanded-origin', 'empty', 'relative'] as const).map(issue =>
      [issue, broken.filter(r => r.findings.some(f => f.issues.includes(issue))).length])),
  }
  if (values.out) writeFileSync(values.out, `${JSON.stringify({ summary, results }, null, 2)}\n`)

  console.log(JSON.stringify(summary, null, 2))
  for (const r of broken) {
    const issues = [...new Set(r.findings.flatMap(f => f.issues))].join(',')
    const sample = r.findings.find(f => f.issues.length)!
    const state = r.newestOnPlatform ? 'NEWEST' : r.supersededBy ? `superseded by ${r.supersededBy}` : 'older'
    console.log(`${r.domain}@${r.version} ${r.platform} [${state}] ${issues} - ${r.findings.length} ELF, e.g. ${sample.member} ${sample.tag}=${JSON.stringify(sample.value)}`)
  }
  for (const r of errors) console.log(`ERROR ${r.domain}@${r.version} ${r.platform}: ${r.error}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`ELF loader path audit failed: ${(error as Error).message}`)
    process.exit(1)
  })
}
