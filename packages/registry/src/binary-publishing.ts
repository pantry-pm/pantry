/**
 * Scan-before-promote publication for installable native artifacts.
 *
 * Builders may upload only to an untrusted staging prefix. The registry reads
 * those exact bytes, scans them, verifies their declared digest/size, and then
 * promotes them into the installable binaries/ namespace. Metadata is written
 * last, so a partial failure never advertises an unverified artifact.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { S3Client } from './storage/aws-client'
import {
  publicScanResult,
  recordMalwareScanResult,
  scanPackageArtifact,
  scanPackageArtifactStream,
  scanBudgetMs,
  scanPackageArtifactUrl,
  type MalwareScanResult,
  type MalwareScanner,
  type PublishSurface,
} from './malware-scanning'

const DEFAULT_MAX_BINARY_BYTES = 1024 * 1024 * 1024
/**
 * How long a signed staging claim stays usable.
 *
 * This is the outermost limit on a publish and it has to outlast everything
 * inside it: the upload, then the scan, then the client polling for a verdict.
 * At one hour it did not. A 183MB artifact uploaded, scanned for the better
 * part of an hour, and then every poll failed with BINARY_UPLOAD_EXPIRED at
 * 60m14s - the claim died while the work it authorized was still going.
 *
 * That was the fourth limit in this chain found the same way, one failed
 * publish at a time. The chain, outermost last, is asserted in the tests:
 *
 *   max scan budget (45m) < client deadline (60m) < attempt cap (65m) < this
 *
 * Three hours leaves room for a slow upload ahead of the client's own window.
 */
export const DEFAULT_STAGING_TTL_SECONDS: number = 3 * 60 * 60

/**
 * How long `complete()` may hold a response open waiting for the scan.
 *
 * Bounded by the smallest enclosing timeout, not by how long a scan takes:
 * the registry's own Bun idle timeout is 255s and rpx cuts upstreams at 300s,
 * so anything at or past those is an aborted connection rather than an answer.
 * 120s leaves generous headroom and still settles every small artifact - the
 * EICAR rehearsal included - in a single call.
 */
const DEFAULT_COMPLETION_RESPONSE_BUDGET_MS = 120_000

/** Retryable "someone is already scanning this, ask again shortly". */
function completionInProgress(): BinaryPublishError {
  return new BinaryPublishError(
    'Completion is already in progress for this upload',
    425,
    'BINARY_COMPLETION_IN_PROGRESS',
  )
}

/**
 * How long a settled completion stays readable.
 *
 * Must outlast the longest scan plus the client's polling deadline, or a
 * result is retired before the thing waiting for it can claim it.
 */
const COMPLETION_RETENTION_MS = 60 * 60_000

/** A completion in flight, or one that finished recently enough to still be claimed. */
interface CompletionState {
  promise: Promise<BinaryPublishCompleted>
  /** Unset while running. */
  settledAt: number | undefined
}
// A retained whole-archive scan may consume the full 30-minute ClamAV
// MaxScanTime before coverage-limit fallback downloads the exact object again.
// Keep the read capability bounded, but long enough for that second request.
const RETAINED_RESCAN_DOWNLOAD_TTL_SECONDS = 60 * 60
const MAX_PLATFORMS = 16
const STAGING_PREFIX = '.pantry-staging/malware'

export interface BinaryPlatformRecord {
  tarball: string
  sha256: string
  size: number
  uploadedAt: string
  malwareScan: MalwareScanResult
}

export interface BinaryPackageMetadata {
  name: string
  latestVersion: string
  versions: Record<string, {
    platforms: Record<string, BinaryPlatformRecord>
  }>
  updatedAt: string
  malwareQuarantines?: BinaryMalwareQuarantine[]
}

export interface BinaryMalwareQuarantine {
  version: string
  platforms: string[]
  artifactSha256: string
  quarantineKey?: string
  filename?: string
  size?: number
  signature?: string
  engine: string
  engineVersion?: string
  databaseVersion?: string
  scannedAt: string
  quarantinedAt: string
  reviewedAt?: string
}

export interface BinaryPublishRequest {
  domain: string
  version: string
  platforms: string[]
  filename: string
  size: number
  sha256: string
}

export interface BinaryRescanRequest {
  domain: string
  version: string
  platforms: string[]
}

export interface BinaryRescanCompleted {
  action: 'already-clean' | 'attested' | 'quarantined'
  domain: string
  version: string
  tarball: string
  platforms: Record<string, BinaryPlatformRecord>
  scan: ReturnType<typeof publicScanResult>
}

export interface BinaryExternalRescanPrepared {
  action: 'already-clean' | 'prepared'
  domain: string
  version: string
  tarball: string
  platforms: string[]
  sha256: string
  size: number
  objectIdentity: string
  downloadUrl?: string
  expiresAt?: string
  scan?: ReturnType<typeof publicScanResult>
}

export interface BinaryQuarantineReviewRequest {
  domain: string
  version: string
  artifactSha256: string
  filename?: string
}

export interface BinaryExternalQuarantineReviewPrepared {
  action: 'already-released' | 'prepared'
  domain: string
  version: string
  platforms: string[]
  artifactSha256: string
  quarantineKey?: string
  filename?: string
  size?: number
  objectIdentity?: string
  downloadUrl?: string
  expiresAt?: string
  scan?: ReturnType<typeof publicScanResult>
}

export interface BinaryQuarantineReviewCompleted {
  action: 'already-released' | 'released' | 'still-quarantined'
  domain: string
  version: string
  platforms: Record<string, BinaryPlatformRecord>
  scan: ReturnType<typeof publicScanResult>
}

interface ExistingRescanState {
  metadataKey: string
  metadata: BinaryPackageMetadata
  selected: Record<string, BinaryPlatformRecord>
  tarball: string
  alreadyClean: boolean
  size: number
  sha256: string
  objectIdentity?: string
}

interface QuarantineReviewState {
  metadataKey: string
  metadata: BinaryPackageMetadata
  quarantine: BinaryMalwareQuarantine
  quarantineKey: string
  filename: string
  size: number
  objectIdentity?: string
}

interface ReleasedQuarantineState {
  domain: string
  version: string
  platforms: Record<string, BinaryPlatformRecord>
  artifactSha256: string
  scan: MalwareScanResult
}

const EXTERNAL_SCAN_MAX_DURATION_MS = 6 * 60 * 60_000
const EXTERNAL_SCAN_SUBMISSION_GRACE_MS = 15 * 60_000
const EXTERNAL_SCAN_CLOCK_SKEW_MS = 5 * 60_000

interface StagingClaim extends BinaryPublishRequest {
  stagingKey: string
  expiresAt: number
}

export interface BinaryPublishInitiated {
  uploadId: string
  uploadUrl: string
  uploadHeaders: Record<string, string>
  expiresAt: string
}

export interface BinaryPublishCompleted {
  domain: string
  version: string
  platforms: Record<string, BinaryPlatformRecord>
  scan: ReturnType<typeof publicScanResult>
}

export interface BinaryArtifactStore {
  getObject(key: string): Promise<Buffer>
  getObjectStream?(key: string): Promise<AsyncIterable<Uint8Array>>
  createDownloadUrl?(key: string, expiresInSeconds: number): string
  putObject(key: string, body: Buffer | string, contentType: string): Promise<void>
  copyObject(sourceKey: string, destinationKey: string): Promise<void>
  deleteObject(key: string): Promise<void>
  headObject(key: string): Promise<Record<string, string>>
  createUploadUrl(key: string, contentType: string, expiresInSeconds: number): string
}

export class S3BinaryArtifactStore implements BinaryArtifactStore {
  constructor(private s3: S3Client, private bucket: string) {}

  getObject(key: string): Promise<Buffer> {
    return this.s3.getObjectBuffer(this.bucket, key)
  }

  async getObjectStream(key: string): Promise<AsyncIterable<Uint8Array>> {
    const { body } = await this.s3.getObjectStream(this.bucket, key)
    return {
      async *[Symbol.asyncIterator]() {
        const reader = body.getReader()
        while (true) {
          const result = await reader.read()
          if (result.done) break
          yield result.value
        }
      },
    }
  }

  createDownloadUrl(key: string, expiresInSeconds: number): string {
    return this.s3.generatePresignedGetUrl(this.bucket, key, expiresInSeconds)
  }

  putObject(key: string, body: Buffer | string, contentType: string): Promise<void> {
    return this.s3.putObject({ bucket: this.bucket, key, body, contentType })
  }

  copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    return this.s3.copyObject(this.bucket, sourceKey, destinationKey)
  }

  deleteObject(key: string): Promise<void> {
    return this.s3.deleteObject(this.bucket, key)
  }

  headObject(key: string): Promise<Record<string, string>> {
    return this.s3.headObject(this.bucket, key)
  }

  createUploadUrl(key: string, contentType: string, expiresInSeconds: number): string {
    return this.s3.generatePresignedPutUrl(this.bucket, key, contentType, expiresInSeconds)
  }
}

export class BinaryPublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly scan?: MalwareScanResult,
  ) {
    super(message)
  }
}

export interface BinaryArtifactPublisherOptions {
  tokenSecret: string
  maxBytes?: number
  /** Migration-only bound for retained artifacts; never changes new publish limits. */
  legacyRescanMaxBytes?: number
  stagingTtlSeconds?: number
  /**
   * How long `complete()` waits inline before telling the caller to poll.
   * Must stay below every enclosing HTTP timeout; see
   * DEFAULT_COMPLETION_RESPONSE_BUDGET_MS.
   */
  completionResponseBudgetMs?: number
  now?: () => number
  onPublished?: (result: BinaryPublishCompleted) => Promise<void>
  /** Enables migration-only external attestations for artifacts uploaded no later than this instant. */
  legacyScanAttestationCutoff?: number
}

const domainPattern = /^[a-z0-9](?:[a-z0-9._-]|\/(?=[a-z0-9])){0,213}$/i
const versionPattern = /^[a-z0-9._+-]{1,64}$/i
const platformPattern = /^(?:darwin|linux|windows|freebsd)-(?:arm64|x86-64|x86|riscv64)$/
const filenamePattern = /^[a-z0-9][a-z0-9._+-]{0,239}\.tar\.gz$/i
const sha256Pattern = /^[a-f0-9]{64}$/

export function validateBinaryPublishRequest(input: unknown, maxBytes: number = DEFAULT_MAX_BINARY_BYTES): BinaryPublishRequest {
  if (!input || typeof input !== 'object')
    throw new BinaryPublishError('Publish request must be an object', 400, 'INVALID_BINARY_PUBLISH')

  const value = input as Record<string, unknown>
  const domain = typeof value.domain === 'string' ? value.domain.trim() : ''
  const version = typeof value.version === 'string' ? value.version.trim() : ''
  const filename = typeof value.filename === 'string' ? value.filename.trim() : ''
  const sha256 = typeof value.sha256 === 'string' ? value.sha256.toLowerCase() : ''
  const size = typeof value.size === 'number' ? value.size : Number.NaN
  const platforms = Array.isArray(value.platforms)
    ? [...new Set(value.platforms.filter((item): item is string => typeof item === 'string').map(item => item.trim()))]
    : []

  if (!domainPattern.test(domain) || domain.includes('..') || domain.endsWith('/'))
    throw new BinaryPublishError('Invalid binary package domain', 422, 'INVALID_BINARY_DOMAIN')
  if (!versionPattern.test(version))
    throw new BinaryPublishError('Invalid binary package version', 422, 'INVALID_BINARY_VERSION')
  if (!filenamePattern.test(filename) || filename.includes('..'))
    throw new BinaryPublishError('Invalid binary artifact filename', 422, 'INVALID_BINARY_FILENAME')
  if (platforms.length === 0 || platforms.length > MAX_PLATFORMS || platforms.some(item => !platformPattern.test(item)))
    throw new BinaryPublishError('One or more binary platforms are invalid', 422, 'INVALID_BINARY_PLATFORM')
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes)
    throw new BinaryPublishError(`Binary artifact size must be between 1 and ${maxBytes} bytes`, 413, 'INVALID_BINARY_SIZE')
  if (!sha256Pattern.test(sha256))
    throw new BinaryPublishError('Binary artifact SHA-256 must be 64 lowercase hexadecimal characters', 422, 'INVALID_BINARY_SHA256')

  return { domain, version, platforms, filename, size, sha256 }
}

export function validateBinaryRescanRequest(input: unknown): BinaryRescanRequest {
  if (!input || typeof input !== 'object')
    throw new BinaryPublishError('Rescan request must be an object', 400, 'INVALID_BINARY_RESCAN')

  const value = input as Record<string, unknown>
  const domain = typeof value.domain === 'string' ? value.domain.trim() : ''
  const version = typeof value.version === 'string' ? value.version.trim() : ''
  const platforms = Array.isArray(value.platforms)
    ? [...new Set(value.platforms.filter((item): item is string => typeof item === 'string').map(item => item.trim()))]
    : []

  if (!domainPattern.test(domain) || domain.includes('..') || domain.endsWith('/'))
    throw new BinaryPublishError('Invalid binary package domain', 422, 'INVALID_BINARY_DOMAIN')
  if (!versionPattern.test(version))
    throw new BinaryPublishError('Invalid binary package version', 422, 'INVALID_BINARY_VERSION')
  if (platforms.length === 0 || platforms.length > MAX_PLATFORMS || platforms.some(item => !platformPattern.test(item)))
    throw new BinaryPublishError('One or more binary platforms are invalid', 422, 'INVALID_BINARY_PLATFORM')
  return { domain, version, platforms }
}

export function validateBinaryQuarantineReviewRequest(input: unknown): BinaryQuarantineReviewRequest {
  if (!input || typeof input !== 'object')
    throw new BinaryPublishError('Quarantine review request must be an object', 400, 'INVALID_BINARY_QUARANTINE_REVIEW')

  const value = input as Record<string, unknown>
  const domain = typeof value.domain === 'string' ? value.domain.trim() : ''
  const version = typeof value.version === 'string' ? value.version.trim() : ''
  const artifactSha256 = typeof value.artifactSha256 === 'string' ? value.artifactSha256.toLowerCase() : ''
  const filename = typeof value.filename === 'string' ? value.filename.trim() : undefined

  if (!domainPattern.test(domain) || domain.includes('..') || domain.endsWith('/'))
    throw new BinaryPublishError('Invalid binary package domain', 422, 'INVALID_BINARY_DOMAIN')
  if (!versionPattern.test(version))
    throw new BinaryPublishError('Invalid binary package version', 422, 'INVALID_BINARY_VERSION')
  if (!sha256Pattern.test(artifactSha256))
    throw new BinaryPublishError('Quarantined artifact SHA-256 must be 64 lowercase hexadecimal characters', 422, 'INVALID_BINARY_SHA256')
  if (filename !== undefined && (!filenamePattern.test(filename) || filename.includes('..')))
    throw new BinaryPublishError('Invalid quarantined artifact filename', 422, 'INVALID_BINARY_FILENAME')
  return { domain, version, artifactSha256, ...(filename ? { filename } : {}) }
}

function storedBinaryKey(tarball: string): string {
  try {
    return decodeURIComponent(new URL(tarball).pathname.replace(/^\/+/, ''))
  }
  catch {
    return decodeURIComponent(tarball.replace(/^\/+/, ''))
  }
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url')
}

function unbase64url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

function signClaim(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseContentLength(headers: Record<string, string>): number | null {
  const raw = headers['content-length'] || headers['Content-Length']
  if (!raw) return null
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function parseObjectIdentity(headers: Record<string, string>): string | undefined {
  return headers['x-amz-version-id']
    || headers['X-Amz-Version-Id']
    || headers.etag
    || headers.ETag
}

function newerVersion(candidate: string, current: string): boolean {
  const a = candidate.split(/[.+_-]/)
  const b = current.split(/[.+_-]/)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = Number(a[i] || 0)
    const right = Number(b[i] || 0)
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right)
      return left > right
    const lexical = (a[i] || '').localeCompare(b[i] || '')
    if (lexical !== 0) return lexical > 0
  }
  return false
}

export function binaryAttestationKey(tarballKey: string): string {
  return `${tarballKey}.scan.json`
}

export function filterBinaryMetadataForCleanScans(
  input: BinaryPackageMetadata,
  allowPending: (domain: string, version: string, platform: string) => boolean = () => false,
): BinaryPackageMetadata {
  const metadata = structuredClone(input)
  metadata.versions ||= {}
  for (const [version, versionInfo] of Object.entries(metadata.versions)) {
    const platforms = versionInfo.platforms || {}
    for (const [platform, record] of Object.entries(platforms)) {
      if (!allowPending(metadata.name, version, platform) && record?.malwareScan?.verdict !== 'clean')
        delete platforms[platform]
    }
    if (Object.keys(platforms).length === 0)
      delete metadata.versions[version]
  }
  if (!metadata.versions[metadata.latestVersion]) {
    metadata.latestVersion = Object.keys(metadata.versions)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .at(0) || ''
  }
  return metadata
}

export function publicBinaryMetadata(
  input: BinaryPackageMetadata,
): BinaryPackageMetadata {
  const metadata = structuredClone(input)
  delete metadata.malwareQuarantines
  return metadata
}

export class BinaryArtifactPublisher {
  private maxBytes: number
  private legacyRescanMaxBytes: number
  private stagingTtlSeconds: number
  private completionResponseBudgetMs: number
  private now: () => number
  private locks = new Map<string, Promise<void>>()

  /**
   * Completions currently running, plus recently settled ones, keyed by
   * upload id.
   *
   * Two problems share this map. First, a publisher retries `complete()`
   * while the first call is still scanning, and that first call has already
   * deleted the staging object; without this, every retry looked like an
   * orphaned upload and started ANOTHER scan of the same artifact, so a slow
   * scan turned 60 polls into 60 concurrent scans of one file.
   *
   * The scan used to run inside the HTTP request that asked for it, which
   * capped it at whatever the enclosing timeouts allowed (255s Bun idle, 300s
   * rpx). A 183MB artifact needs longer than that, so the scan was killed at
   * its 270s deadline and reported as MALWARE_SCAN_UNAVAILABLE - a scanner
   * that was working fine, described as broken.
   *
   * The scan now outlives the request. A caller waits inline only as long as
   * the response budget allows; past that it gets 425 and polls, while the
   * scan keeps running against its own, size-derived deadline.
   *
   * Sealed but NOT present here means the previous attempt died outright and
   * the upload really is orphaned, which is the only case worth resuming.
   */
  private completing = new Map<string, CompletionState>()

  constructor(
    private store: BinaryArtifactStore,
    private scanner: MalwareScanner,
    private options: BinaryArtifactPublisherOptions,
  ) {
    if (!options.tokenSecret || options.tokenSecret.length < 16)
      throw new Error('binary staging token secret must contain at least 16 characters')
    this.maxBytes = options.maxBytes || DEFAULT_MAX_BINARY_BYTES
    this.legacyRescanMaxBytes = options.legacyRescanMaxBytes || this.maxBytes
    if (!Number.isSafeInteger(this.legacyRescanMaxBytes) || this.legacyRescanMaxBytes < this.maxBytes)
      throw new Error('legacy rescan limit must be a safe integer at least as large as the publish limit')
    this.stagingTtlSeconds = options.stagingTtlSeconds || DEFAULT_STAGING_TTL_SECONDS
    this.completionResponseBudgetMs
      = options.completionResponseBudgetMs || DEFAULT_COMPLETION_RESPONSE_BUDGET_MS
    this.now = options.now || Date.now
  }

  initiate(input: unknown): BinaryPublishInitiated {
    const request = validateBinaryPublishRequest(input, this.maxBytes)
    const claim: StagingClaim = {
      ...request,
      stagingKey: `${STAGING_PREFIX}/${randomUUID()}/${request.filename}`,
      expiresAt: this.now() + this.stagingTtlSeconds * 1000,
    }
    const payload = base64url(JSON.stringify(claim))
    const signature = signClaim(payload, this.options.tokenSecret)

    return {
      uploadId: `${payload}.${signature}`,
      uploadUrl: this.store.createUploadUrl(claim.stagingKey, 'application/gzip', this.stagingTtlSeconds),
      uploadHeaders: { 'Content-Type': 'application/gzip' },
      expiresAt: new Date(claim.expiresAt).toISOString(),
    }
  }

  /**
   * Complete an upload on behalf of an HTTP caller.
   *
   * Bounded by what a response can hold open; a scan that outruns that budget
   * keeps going and the caller polls. See completeAwaitingScan for in-process
   * callers, which have no such bound.
   */
  async complete(
    uploadId: string,
    publisher?: string,
    surface: Extract<PublishSurface, 'binary' | 'pkgx'> = 'binary',
  ): Promise<BinaryPublishCompleted> {
    return this.completeWithin(this.completionResponseBudgetMs, uploadId, publisher, surface)
  }

  /**
   * Complete an upload, waiting for the verdict however long it takes.
   *
   * For callers inside the process - publishBuffer, the pkgx fallback - which
   * are not holding a response open and have nothing to poll with. Handing
   * them a retryable 425 would just be an error they cannot act on.
   */
  async completeAwaitingScan(
    uploadId: string,
    publisher?: string,
    surface: Extract<PublishSurface, 'binary' | 'pkgx'> = 'binary',
  ): Promise<BinaryPublishCompleted> {
    return this.completeWithin(undefined, uploadId, publisher, surface)
  }

  /** @param responseBudgetMs undefined waits for the scan however long it takes. */
  private async completeWithin(
    responseBudgetMs: number | undefined,
    uploadId: string,
    publisher?: string,
    surface: Extract<PublishSurface, 'binary' | 'pkgx'> = 'binary',
  ): Promise<BinaryPublishCompleted> {
    const claim = this.verifyClaim(uploadId, { allowExpired: true })

    // Consulted BEFORE any object lookup. A completion that already ran
    // deleted both the staging and sealed objects on its way out, so an
    // object-first poll reports BINARY_STAGING_NOT_FOUND and the verdict it
    // was polling for is lost - a blocked artifact would read as a missing
    // upload. The recorded outcome is authoritative whatever the store holds.
    this.pruneSettledCompletions()
    const running = this.completing.get(uploadId)
    if (running) {
      // Answer a poll at once: the result if it is ready, otherwise "wait".
      // An unbounded caller waits for it instead of being told to retry.
      if (running.settledAt === undefined && responseBudgetMs !== undefined)
        throw completionInProgress()
      return await running.promise
    }

    // Past this point we would be starting or resuming work, which an expired
    // claim may not authorize.
    if (claim.expiresAt < this.now())
      throw new BinaryPublishError('Binary staging upload has expired', 410, 'BINARY_UPLOAD_EXPIRED')

    const sealedKey = claim.stagingKey.replace(`${STAGING_PREFIX}/`, '.pantry-staging/sealed/')
    let stagingExists = true
    try {
      const head = await this.store.headObject(claim.stagingKey)
      const contentLength = parseContentLength(head)
      if (contentLength !== null && contentLength !== claim.size)
        throw new BinaryPublishError('Staged artifact size does not match the initiated upload', 422, 'BINARY_SIZE_MISMATCH')
    }
    catch (error) {
      if (error instanceof BinaryPublishError) throw error
      stagingExists = false
    }

    // A completion that got as far as sealing has already deleted the staging
    // object, so "staging is gone" does not mean "nothing was uploaded".
    let sealedExists = false
    if (!stagingExists) {
      const existing = await this.findCompleted(claim)
      if (existing) return existing

      // The artifact may still be sealed: either a concurrent attempt is
      // mid-scan, or an earlier one died after sealing and before promoting.
      // The latter used to orphan the upload permanently - staging deleted,
      // promotion never recorded - so every subsequent retry returned
      // BINARY_STAGING_NOT_FOUND forever and the only way out was to rebuild.
      // Resuming from the sealed copy makes complete() genuinely idempotent.
      try {
        await this.store.headObject(sealedKey)
        sealedExists = true
      }
      catch {
        sealedExists = false
      }

      if (!sealedExists)
        throw new BinaryPublishError('Staged artifact was not found or has expired', 404, 'BINARY_STAGING_NOT_FOUND')

      // No early "already in progress" throw here. Entries now outlive the
      // scan so they can carry its result, which means `has()` stays true
      // after it settles; short-circuiting on it would hide the finished
      // verdict and make every poll wait out the client's full deadline.
      // beginCompletion adopts a running scan instead of starting a rival one.
    }

    const state = this.beginCompletion(uploadId, () =>
      this.runCompletion(claim, sealedKey, stagingExists, publisher, surface))

    if (responseBudgetMs === undefined)
      return await state.promise

    // The call that STARTED the scan waits, but only as long as a response can
    // safely be held open. Small artifacts - including the EICAR rehearsal the
    // deploy asserts on - settle well inside this and still get a definitive
    // verdict in a single call.
    let budgetTimer: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race([
      state.promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        budgetTimer = setTimeout(() => resolve(false), responseBudgetMs)
      }),
    ]).finally(() => {
      // Without this the timer keeps the process alive for the whole budget
      // after a fast scan has already answered.
      if (budgetTimer) clearTimeout(budgetTimer)
    })
    if (!settled)
      throw completionInProgress()
    return await state.promise
  }

  /**
   * Start a completion for an upload that has none running.
   *
   * Callers arriving for an existing completion are answered earlier, from the
   * map, so this only ever begins fresh work.
   */
  private beginCompletion(
    uploadId: string,
    run: () => Promise<BinaryPublishCompleted>,
  ): CompletionState {

    const state: CompletionState = { promise: undefined as never, settledAt: undefined }
    state.promise = run().finally(() => {
      state.settledAt = Date.now()
    })
    // Nothing may await this promise before the next poll arrives, and an
    // unobserved rejection would take the process down.
    state.promise.catch(() => {})
    this.completing.set(uploadId, state)
    return state
  }

  /**
   * Drop settled completions once no client can still be polling for them.
   *
   * Retention matches the publish client's own deadline, so a result is always
   * available for as long as someone may ask, and never longer.
   */
  private pruneSettledCompletions(): void {
    const cutoff = Date.now() - COMPLETION_RETENTION_MS
    for (const [id, state] of this.completing) {
      if (state.settledAt !== undefined && state.settledAt < cutoff)
        this.completing.delete(id)
    }
  }

  private async runCompletion(
    claim: StagingClaim,
    sealedKey: string,
    stagingExists: boolean,
    publisher?: string,
    surface: Extract<PublishSurface, 'binary' | 'pkgx'> = 'binary',
  ): Promise<BinaryPublishCompleted> {
    try {
      // Seal the object before scanning. The presigned URL can write only the
      // original staging key, so a retry/overwrite cannot race the scan and the
      // subsequent server-side promotion.
      //
      // Skipped when resuming: the sealed copy is already the authoritative
      // one, and the staging key it came from no longer exists.
      if (stagingExists) {
        await this.store.copyObject(claim.stagingKey, sealedKey)
        await this.store.deleteObject(claim.stagingKey)
      }

      const context = {
        surface,
        name: claim.domain,
        version: claim.version,
        publisher,
      } as const
      let scan: MalwareScanResult
      if (this.store.createDownloadUrl && this.scanner.scanUrl) {
        scan = await scanPackageArtifactUrl(
          this.scanner,
          // Outlives the scan it is for. These were independent - a fixed
          // 10-minute URL and a separately-sized scan budget - and a URL that
          // expires mid-download fails the scan with the same
          // "scanner unavailable" verdict as a genuinely dead scanner, which
          // is indistinguishable from the outside.
          this.store.createDownloadUrl(sealedKey, Math.ceil(scanBudgetMs(claim.size) / 1000) + 120),
          context,
          { sha256: claim.sha256, size: claim.size },
        )
      }
      else if (this.store.getObjectStream && this.scanner.scanStream) {
        scan = await scanPackageArtifactStream(
          this.scanner,
          await this.store.getObjectStream(sealedKey),
          context,
          { sha256: claim.sha256, size: claim.size },
        )
      }
      else {
        const bytes = await this.store.getObject(sealedKey)
        if (bytes.byteLength !== claim.size)
          throw new BinaryPublishError('Staged artifact size does not match the initiated upload', 422, 'BINARY_SIZE_MISMATCH')
        scan = await scanPackageArtifact(
          this.scanner,
          Uint8Array.from(bytes).buffer,
          context,
        )
      }

      if (scan.artifactSha256 !== claim.sha256)
        throw new BinaryPublishError('Staged artifact SHA-256 does not match the initiated upload', 422, 'BINARY_SHA256_MISMATCH', scan)
      if (scan.verdict === 'blocked') {
        if (surface === 'pkgx')
          await this.quarantineBlockedFallback(claim, sealedKey, scan)
        throw new BinaryPublishError('Binary artifact blocked by malware scanning', 422, 'MALWARE_DETECTED', scan)
      }
      if (scan.verdict === 'review')
        throw new BinaryPublishError('Binary artifact requires security review', 202, 'PACKAGE_REQUIRES_REVIEW', scan)
      if (scan.verdict !== 'clean')
        throw new BinaryPublishError('Binary artifact malware scanning is temporarily unavailable', 503, 'MALWARE_SCAN_UNAVAILABLE', scan)

      const completed = await this.withDomainLock(claim.domain, () => this.promote(claim, sealedKey, scan))
      await this.options.onPublished?.(completed)
      return completed
    }
    finally {
      // The map entry is NOT dropped here. It holds the outcome this upload's
      // next poll will read; pruneSettledCompletions retires it once the
      // client's own deadline has passed.
      await this.store.deleteObject(claim.stagingKey).catch(() => {})
      await this.store.deleteObject(sealedKey).catch(() => {})
    }
  }

  async publishBuffer(
    input: BinaryPublishRequest,
    bytes: Buffer,
    publisher?: string,
    surface: Extract<PublishSurface, 'binary' | 'pkgx'> = 'binary',
  ): Promise<BinaryPublishCompleted> {
    const request = validateBinaryPublishRequest(input, this.maxBytes)
    if (bytes.byteLength !== request.size)
      throw new BinaryPublishError('Artifact buffer size does not match the publish request', 422, 'BINARY_SIZE_MISMATCH')
    const initiated = this.initiate(request)
    const claim = this.verifyClaim(initiated.uploadId)
    await this.store.putObject(claim.stagingKey, bytes, 'application/gzip')
    // In-process: nothing here can poll a 425, so wait for the verdict.
    return this.completeAwaitingScan(initiated.uploadId, publisher, surface)
  }

  async rescanExisting(input: unknown, publisher?: string): Promise<BinaryRescanCompleted> {
    const request = validateBinaryRescanRequest(input)
    const prepared = await this.withDomainLock<
      { completed: BinaryRescanCompleted } | { state: ExistingRescanState }
    >(request.domain, async () => {
      const state = await this.loadExistingRescan(request)
      const durableScan = await this.readCleanAttestation(state.tarball, state.sha256)
      if (durableScan) {
        return {
          completed: await this.finishDurableRescan(state, request, durableScan),
        }
      }
      return { state }
    })
    if ('completed' in prepared)
      return prepared.completed

    const planned = prepared.state
    const context = {
      surface: 'binary' as const,
      name: request.domain,
      version: request.version,
      publisher,
    }
    let scan: MalwareScanResult
    if (this.store.createDownloadUrl && this.scanner.scanUrl) {
      scan = await scanPackageArtifactUrl(
        this.scanner,
        this.store.createDownloadUrl(planned.tarball, 10 * 60),
        context,
        { sha256: planned.sha256, size: planned.size },
      )
    }
    else if (this.store.getObjectStream && this.scanner.scanStream) {
      scan = await scanPackageArtifactStream(
        this.scanner,
        await this.store.getObjectStream(planned.tarball),
        context,
        { sha256: planned.sha256, size: planned.size },
      )
    }
    else {
      const bytes = await this.store.getObject(planned.tarball)
      if (bytes.byteLength !== planned.size)
        throw new BinaryPublishError('Retained artifact size does not match metadata', 422, 'BINARY_SIZE_MISMATCH')
      scan = await scanPackageArtifact(this.scanner, Uint8Array.from(bytes).buffer, context)
    }

    if (scan.artifactSha256 !== planned.sha256)
      throw new BinaryPublishError('Retained artifact SHA-256 does not match metadata', 422, 'BINARY_SHA256_MISMATCH', scan)
    if (scan.verdict === 'error')
      throw new BinaryPublishError('Binary artifact malware scanning is temporarily unavailable', 503, 'MALWARE_SCAN_UNAVAILABLE', scan)

    // Byte scanning is intentionally outside the per-domain metadata lock so
    // independent retained artifacts can use the daemon's two bounded streams.
    // Re-read and compare the exact object identity before applying the verdict.
    return this.withDomainLock(request.domain, async () => {
      const current = await this.loadExistingRescan(request)
      if (
        current.tarball !== planned.tarball
        || current.sha256 !== planned.sha256
        || current.size !== planned.size
        || current.objectIdentity !== planned.objectIdentity
      ) {
        throw new BinaryPublishError(
          'Retained artifact changed while malware scanning was in progress',
          409,
          'BINARY_RESCAN_ARTIFACT_CHANGED',
        )
      }
      const durableScan = await this.readCleanAttestation(current.tarball, current.sha256)
      if (durableScan)
        return this.finishDurableRescan(current, request, durableScan)
      if (scan.verdict === 'blocked' || scan.verdict === 'review')
        return this.quarantineExisting(current.metadataKey, current.metadata, request, current.tarball, scan)
      if (scan.verdict !== 'clean')
        throw new BinaryPublishError('Binary artifact malware scanning is temporarily unavailable', 503, 'MALWARE_SCAN_UNAVAILABLE', scan)

      return this.attestExisting(
        current.metadataKey,
        current.metadata,
        request,
        current.tarball,
        current.sha256,
        current.size,
        scan,
      )
    })
  }

  async prepareExternalRescan(input: unknown): Promise<BinaryExternalRescanPrepared> {
    const request = validateBinaryRescanRequest(input)
    return this.withDomainLock(request.domain, async () => {
      const state = await this.loadExistingRescan(request)
      const durableScan = await this.readCleanAttestation(state.tarball, state.sha256)
      if (durableScan) {
        const completed = await this.finishDurableRescan(state, request, durableScan)
        return {
          action: 'already-clean',
          domain: request.domain,
          version: request.version,
          tarball: state.tarball,
          platforms: Object.keys(completed.platforms),
          sha256: state.sha256,
          size: state.size,
          objectIdentity: state.objectIdentity!,
          scan: completed.scan,
        }
      }
      // A current Registry publish writes digest-bound scan evidence before it
      // updates metadata. Metadata reconstruction may therefore need to recover
      // that evidence even when the object's timestamp is newer than the legacy
      // migration cutoff. Only an artifact without durable evidence needs the
      // restricted external-scanner path.
      this.assertExternalRescanEligible(state)
      if (!this.store.createDownloadUrl)
        throw new BinaryPublishError('Retained artifact download preparation is unavailable', 503, 'BINARY_RESCAN_PREPARE_UNAVAILABLE')
      const expiresInSeconds = RETAINED_RESCAN_DOWNLOAD_TTL_SECONDS
      return {
        action: 'prepared',
        domain: request.domain,
        version: request.version,
        tarball: state.tarball,
        platforms: request.platforms,
        sha256: state.sha256,
        size: state.size,
        objectIdentity: state.objectIdentity!,
        downloadUrl: this.store.createDownloadUrl(state.tarball, expiresInSeconds),
        expiresAt: new Date(this.now() + expiresInSeconds * 1000).toISOString(),
      }
    })
  }

  async attestExternalRescan(input: unknown, publisher?: string): Promise<BinaryRescanCompleted> {
    if (!input || typeof input !== 'object')
      throw new BinaryPublishError('External rescan attestation must be an object', 400, 'INVALID_BINARY_RESCAN_ATTESTATION')
    const value = input as Record<string, unknown>
    const request = validateBinaryRescanRequest(value)
    const tarball = typeof value.tarball === 'string' ? storedBinaryKey(value.tarball) : ''
    const sha256 = typeof value.sha256 === 'string' ? value.sha256.toLowerCase() : ''
    const preparedSha256 = typeof value.preparedSha256 === 'string'
      ? value.preparedSha256.toLowerCase()
      : sha256
    const size = typeof value.size === 'number' ? value.size : Number.NaN
    const objectIdentity = typeof value.objectIdentity === 'string' ? value.objectIdentity : ''
    if (
      !tarball
      || !sha256Pattern.test(sha256)
      || !sha256Pattern.test(preparedSha256)
      || !Number.isSafeInteger(size)
      || size <= 0
      || !objectIdentity
    ) {
      throw new BinaryPublishError('External rescan artifact identity is invalid', 422, 'INVALID_BINARY_RESCAN_ATTESTATION')
    }
    const scan = this.validateExternalScan(value.scan, sha256)

    return this.withDomainLock(request.domain, async () => {
      const current = await this.loadExistingRescan(request)
      if (
        current.tarball !== tarball
        || current.sha256 !== preparedSha256
        || current.size !== size
        || current.objectIdentity !== objectIdentity
      ) {
        throw new BinaryPublishError(
          'Retained artifact changed after external scan preparation',
          409,
          'BINARY_RESCAN_ARTIFACT_CHANGED',
        )
      }
      const durableScan = await this.readCleanAttestation(current.tarball, current.sha256)
      if (durableScan)
        return this.finishDurableRescan(current, request, durableScan)
      this.assertExternalRescanEligible(current)

      recordMalwareScanResult({
        surface: 'binary',
        name: request.domain,
        version: request.version,
        publisher,
      }, scan)
      if (scan.verdict === 'blocked')
        return this.quarantineExisting(current.metadataKey, current.metadata, request, current.tarball, scan)
      return this.attestExisting(
        current.metadataKey,
        current.metadata,
        request,
        current.tarball,
        sha256,
        current.size,
        scan,
      )
    })
  }

  async prepareExternalQuarantineReview(input: unknown): Promise<BinaryExternalQuarantineReviewPrepared> {
    const request = validateBinaryQuarantineReviewRequest(input)
    return this.withDomainLock(request.domain, async () => {
      const loaded = await this.loadQuarantineReview(request)
      if ('released' in loaded) {
        return {
          action: 'already-released',
          domain: loaded.released.domain,
          version: loaded.released.version,
          platforms: Object.keys(loaded.released.platforms),
          artifactSha256: loaded.released.artifactSha256,
          scan: publicScanResult(loaded.released.scan),
        }
      }
      if (!loaded.state.objectIdentity)
        throw new BinaryPublishError('Quarantined artifact has no stable object identity', 422, 'BINARY_OBJECT_IDENTITY_MISSING')
      if (!this.store.createDownloadUrl)
        throw new BinaryPublishError('Quarantine review download preparation is unavailable', 503, 'BINARY_QUARANTINE_REVIEW_PREPARE_UNAVAILABLE')
      const expiresInSeconds = 15 * 60
      return {
        action: 'prepared',
        domain: request.domain,
        version: request.version,
        platforms: loaded.state.quarantine.platforms,
        artifactSha256: request.artifactSha256,
        quarantineKey: loaded.state.quarantineKey,
        filename: loaded.state.filename,
        size: loaded.state.size,
        objectIdentity: loaded.state.objectIdentity,
        downloadUrl: this.store.createDownloadUrl(loaded.state.quarantineKey, expiresInSeconds),
        expiresAt: new Date(this.now() + expiresInSeconds * 1000).toISOString(),
      }
    })
  }

  async attestExternalQuarantineReview(input: unknown, publisher?: string): Promise<BinaryQuarantineReviewCompleted> {
    if (!input || typeof input !== 'object')
      throw new BinaryPublishError('External quarantine review attestation must be an object', 400, 'INVALID_BINARY_QUARANTINE_REVIEW_ATTESTATION')
    const value = input as Record<string, unknown>
    const request = validateBinaryQuarantineReviewRequest(value)
    const quarantineKey = typeof value.quarantineKey === 'string' ? storedBinaryKey(value.quarantineKey) : ''
    const size = typeof value.size === 'number' ? value.size : Number.NaN
    const objectIdentity = typeof value.objectIdentity === 'string' ? value.objectIdentity : ''
    if (!quarantineKey || !Number.isSafeInteger(size) || size <= 0 || !objectIdentity)
      throw new BinaryPublishError('External quarantine review identity is invalid', 422, 'INVALID_BINARY_QUARANTINE_REVIEW_ATTESTATION')
    const scan = this.validateExternalScan(value.scan, request.artifactSha256)

    return this.withDomainLock(request.domain, async () => {
      const loaded = await this.loadQuarantineReview(request)
      if ('released' in loaded) {
        return {
          action: 'already-released',
          domain: loaded.released.domain,
          version: loaded.released.version,
          platforms: loaded.released.platforms,
          scan: publicScanResult(loaded.released.scan),
        }
      }
      const state = loaded.state
      if (
        state.quarantineKey !== quarantineKey
        || state.size !== size
        || state.objectIdentity !== objectIdentity
      ) {
        throw new BinaryPublishError(
          'Quarantined artifact changed after external scan preparation',
          409,
          'BINARY_QUARANTINE_ARTIFACT_CHANGED',
        )
      }

      recordMalwareScanResult({
        surface: 'binary',
        name: request.domain,
        version: request.version,
        publisher,
      }, scan)
      if (scan.verdict === 'blocked')
        return this.keepQuarantinedAfterReview(state, scan)
      return this.releaseQuarantine(state, request, scan)
    })
  }

  private assertExternalRescanEligible(state: ExistingRescanState): void {
    const cutoff = this.options.legacyScanAttestationCutoff
    if (!Number.isFinite(cutoff))
      throw new BinaryPublishError('External legacy scan attestation is disabled', 403, 'BINARY_EXTERNAL_ATTESTATION_DISABLED')
    if (!state.objectIdentity)
      throw new BinaryPublishError('Retained artifact has no stable object identity', 422, 'BINARY_OBJECT_IDENTITY_MISSING')
    for (const record of Object.values(state.selected)) {
      const uploadedAt = Date.parse(record.uploadedAt)
      if (!Number.isFinite(uploadedAt) || uploadedAt > cutoff!) {
        throw new BinaryPublishError(
          'External attestation is limited to legacy artifacts uploaded before the configured cutoff',
          403,
          'BINARY_EXTERNAL_ATTESTATION_NOT_LEGACY',
        )
      }
    }
  }

  private validateExternalScan(input: unknown, expectedSha256: string): MalwareScanResult {
    if (!input || typeof input !== 'object')
      throw new BinaryPublishError('External scan result is required', 422, 'INVALID_BINARY_RESCAN_ATTESTATION')
    const scan = input as Partial<MalwareScanResult>
    const scannedAt = typeof scan.scannedAt === 'string' ? Date.parse(scan.scannedAt) : Number.NaN
    const ageMs = this.now() - scannedAt
    const durationMs = scan.durationMs
    if (
      (scan.verdict !== 'clean' && scan.verdict !== 'blocked')
      || scan.engine !== 'clamav'
      || scan.artifactSha256 !== expectedSha256
      || !Number.isFinite(scannedAt)
      || ageMs < -EXTERNAL_SCAN_CLOCK_SKEW_MS
      || ageMs > EXTERNAL_SCAN_MAX_DURATION_MS + EXTERNAL_SCAN_SUBMISSION_GRACE_MS
      || typeof durationMs !== 'number'
      || !Number.isFinite(durationMs)
      || durationMs < 0
      || durationMs > EXTERNAL_SCAN_MAX_DURATION_MS
      || durationMs > ageMs + EXTERNAL_SCAN_CLOCK_SKEW_MS
      || typeof scan.engineVersion !== 'string'
      || scan.engineVersion.trim().length === 0
      || scan.engineVersion.length > 128
      || typeof scan.databaseVersion !== 'string'
      || scan.databaseVersion.trim().length === 0
      || scan.databaseVersion.length > 128
      || (scan.verdict === 'blocked' && (typeof scan.signature !== 'string' || scan.signature.trim().length === 0))
      || (scan.signature !== undefined && scan.signature.length > 256)
      || scan.reason !== undefined
    ) {
      throw new BinaryPublishError('External scan result is invalid or stale', 422, 'INVALID_BINARY_RESCAN_ATTESTATION')
    }
    return {
      verdict: scan.verdict,
      engine: 'clamav',
      scannedAt: scan.scannedAt!,
      durationMs,
      artifactSha256: scan.artifactSha256!,
      engineVersion: scan.engineVersion,
      databaseVersion: scan.databaseVersion,
      ...(scan.signature ? { signature: scan.signature } : {}),
    }
  }

  private async loadQuarantineReview(
    request: BinaryQuarantineReviewRequest,
  ): Promise<
    { state: QuarantineReviewState }
    | { released: ReleasedQuarantineState }
  > {
    const metadataKey = `binaries/${request.domain}/metadata.json`
    let metadata: BinaryPackageMetadata
    try {
      metadata = JSON.parse((await this.store.getObject(metadataKey)).toString('utf8')) as BinaryPackageMetadata
    }
    catch {
      throw new BinaryPublishError('Binary package metadata was not found', 404, 'BINARY_METADATA_NOT_FOUND')
    }

    let quarantine = metadata.malwareQuarantines?.find(item =>
      item.version === request.version
      && item.artifactSha256 === request.artifactSha256,
    )
    let recoveredTombstone = false
    if (!quarantine) {
      const platforms = Object.entries(metadata.versions?.[request.version]?.platforms || {})
        .filter(([, record]) =>
          record.sha256 === request.artifactSha256
          && record.malwareScan?.verdict === 'clean'
          && record.malwareScan.artifactSha256 === request.artifactSha256,
        )
      if (platforms.length > 0) {
        const records = Object.fromEntries(platforms)
        const scan = platforms[0][1].malwareScan
        return {
          released: {
            domain: request.domain,
            version: request.version,
            platforms: records,
            artifactSha256: request.artifactSha256,
            scan,
          },
        }
      }
      quarantine = await this.recoverQuarantineTombstone(request)
      if (!quarantine)
        throw new BinaryPublishError('Malware quarantine tombstone was not found', 404, 'BINARY_QUARANTINE_NOT_FOUND')
      metadata.malwareQuarantines ||= []
      metadata.malwareQuarantines.push(quarantine)
      recoveredTombstone = true
    }
    if (
      quarantine.platforms.length === 0
      || quarantine.platforms.length > MAX_PLATFORMS
      || quarantine.platforms.some(platform => !platformPattern.test(platform))
    ) {
      throw new BinaryPublishError('Malware quarantine platforms are invalid', 422, 'INVALID_BINARY_QUARANTINE')
    }

    const domainPrefix = `.pantry-quarantine/malware/${request.domain}/`
    const legacyPrefix = `${domainPrefix}${request.version}/${request.artifactSha256}/`
    const quarantineKey = quarantine.quarantineKey
      ? storedBinaryKey(quarantine.quarantineKey)
      : request.filename
        ? `${legacyPrefix}${request.filename}`
        : ''
    const digestSegment = `/${request.artifactSha256}/`
    const digestOffset = quarantineKey.indexOf(digestSegment, domainPrefix.length)
    if (
      !quarantineKey.startsWith(domainPrefix)
      || digestOffset <= domainPrefix.length
      || quarantineKey.indexOf('/', domainPrefix.length) !== digestOffset
      || quarantineKey.endsWith('.scan.json')
    ) {
      throw new BinaryPublishError(
        'Legacy quarantine review requires the original validated filename',
        422,
        'BINARY_QUARANTINE_FILENAME_REQUIRED',
      )
    }
    const storedVersion = quarantineKey.slice(domainPrefix.length, digestOffset)
    const filename = quarantine.filename || quarantineKey.slice(digestOffset + digestSegment.length)
    if (
      !versionPattern.test(storedVersion)
      || !filenamePattern.test(filename)
      || filename.includes('..')
      || quarantineKey !== `${domainPrefix}${storedVersion}${digestSegment}${filename}`
    )
      throw new BinaryPublishError('Malware quarantine object identity is invalid', 422, 'INVALID_BINARY_QUARANTINE')

    let size: number
    let objectIdentity: string | undefined
    try {
      const head = await this.store.headObject(quarantineKey)
      size = parseContentLength(head) ?? quarantine.size ?? 0
      objectIdentity = parseObjectIdentity(head)
    }
    catch {
      throw new BinaryPublishError('Quarantined binary artifact was not found', 404, 'BINARY_QUARANTINE_ARTIFACT_NOT_FOUND')
    }
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.legacyRescanMaxBytes)
      throw new BinaryPublishError(`Quarantined artifact size must be between 1 and ${this.legacyRescanMaxBytes} bytes`, 413, 'INVALID_BINARY_SIZE')
    if (recoveredTombstone) {
      quarantine.size = size
      metadata.updatedAt = new Date(this.now()).toISOString()
      await this.store.putObject(metadataKey, JSON.stringify(metadata, null, 2), 'application/json')
    }

    return {
      state: {
        metadataKey,
        metadata,
        quarantine,
        quarantineKey,
        filename,
        size,
        objectIdentity,
      },
    }
  }

  private async recoverQuarantineTombstone(
    request: BinaryQuarantineReviewRequest,
  ): Promise<BinaryMalwareQuarantine | undefined> {
    if (!request.filename)
      return
    const quarantineKey = `.pantry-quarantine/malware/${request.domain}/${request.version}/${request.artifactSha256}/${request.filename}`
    let value: unknown
    try {
      value = JSON.parse((await this.store.getObject(`${quarantineKey}.scan.json`)).toString('utf8'))
    }
    catch {
      return
    }
    if (!value || typeof value !== 'object')
      return
    const evidence = value as Record<string, unknown>
    const scan = evidence.scan
    if (!scan || typeof scan !== 'object')
      return
    const storedScan = scan as Partial<MalwareScanResult>
    const quarantinedAt = typeof evidence.quarantinedAt === 'string' ? evidence.quarantinedAt : ''
    if (
      evidence.domain !== request.domain
      || evidence.version !== request.version
      || storedScan.verdict !== 'blocked'
      || storedScan.artifactSha256 !== request.artifactSha256
      || typeof storedScan.engine !== 'string'
      || storedScan.engine.trim().length === 0
      || typeof storedScan.scannedAt !== 'string'
      || !Number.isFinite(Date.parse(storedScan.scannedAt))
      || !Number.isFinite(Date.parse(quarantinedAt))
      || (storedScan.signature !== undefined && typeof storedScan.signature !== 'string')
    )
      return

    let platforms = Array.isArray(evidence.platforms)
      ? evidence.platforms.filter((item): item is string => typeof item === 'string')
      : []
    if (platforms.length === 0 && typeof evidence.originalKey === 'string') {
      const prefix = `binaries/${request.domain}/${request.version}/`
      const suffix = `/${request.filename}`
      const originalKey = storedBinaryKey(evidence.originalKey)
      if (originalKey.startsWith(prefix) && originalKey.endsWith(suffix))
        platforms = [originalKey.slice(prefix.length, -suffix.length)]
    }
    platforms = [...new Set(platforms)].sort()
    if (platforms.length === 0 || platforms.length > MAX_PLATFORMS || platforms.some(platform => !platformPattern.test(platform)))
      return

    return {
      version: request.version,
      platforms,
      artifactSha256: request.artifactSha256,
      quarantineKey,
      filename: request.filename,
      ...(storedScan.signature ? { signature: storedScan.signature } : {}),
      engine: storedScan.engine,
      ...(storedScan.engineVersion ? { engineVersion: storedScan.engineVersion } : {}),
      ...(storedScan.databaseVersion ? { databaseVersion: storedScan.databaseVersion } : {}),
      scannedAt: storedScan.scannedAt,
      quarantinedAt,
    }
  }

  private async loadExistingRescan(request: BinaryRescanRequest): Promise<ExistingRescanState> {
    const metadataKey = `binaries/${request.domain}/metadata.json`
    let metadata: BinaryPackageMetadata
    try {
      metadata = JSON.parse((await this.store.getObject(metadataKey)).toString('utf8')) as BinaryPackageMetadata
    }
    catch {
      throw new BinaryPublishError('Binary package metadata was not found', 404, 'BINARY_METADATA_NOT_FOUND')
    }

    const selected: Record<string, BinaryPlatformRecord> = {}
    for (const platform of request.platforms) {
      const record = metadata.versions?.[request.version]?.platforms?.[platform]
      if (!record)
        throw new BinaryPublishError(`Binary platform was not found: ${platform}`, 404, 'BINARY_PLATFORM_NOT_FOUND')
      selected[platform] = record
    }

    const tarballs = [...new Set(Object.values(selected).map(record => storedBinaryKey(record.tarball)))]
    if (tarballs.length !== 1)
      throw new BinaryPublishError('Rescan platforms must reference the same retained artifact', 422, 'BINARY_RESCAN_ARTIFACT_MISMATCH')
    const tarball = tarballs[0]
    if (!tarball.startsWith(`binaries/${request.domain}/${request.version}/`))
      throw new BinaryPublishError('Retained artifact is outside its package namespace', 422, 'BINARY_RESCAN_ARTIFACT_MISMATCH')

    const alreadyClean = Object.values(selected).every(record =>
      record.malwareScan?.verdict === 'clean'
      && record.malwareScan.artifactSha256 === record.sha256,
    )

    let size: number
    let objectIdentity: string | undefined
    try {
      const head = await this.store.headObject(tarball)
      const observed = parseContentLength(head)
      size = observed ?? Object.values(selected)[0].size
      objectIdentity = parseObjectIdentity(head)
    }
    catch {
      throw new BinaryPublishError('Retained binary artifact was not found', 404, 'BINARY_ARTIFACT_NOT_FOUND')
    }
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.legacyRescanMaxBytes)
      throw new BinaryPublishError(`Retained binary artifact size must be between 1 and ${this.legacyRescanMaxBytes} bytes`, 413, 'INVALID_BINARY_SIZE')

    let sha256 = Object.values(selected)
      .map(record => record.sha256)
      .find(value => sha256Pattern.test(value || ''))
    if (!sha256) {
      try {
        const checksum = (await this.store.getObject(`${tarball}.sha256`)).toString('utf8')
        sha256 = checksum.match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase()
      }
      catch {}
    }
    if (!sha256)
      throw new BinaryPublishError('Retained binary artifact has no valid SHA-256', 422, 'BINARY_SHA256_MISSING')

    return { metadataKey, metadata, selected, tarball, alreadyClean, size, sha256, objectIdentity }
  }

  private async finishDurableRescan(
    state: ExistingRescanState,
    request: BinaryRescanRequest,
    scan: MalwareScanResult,
  ): Promise<BinaryRescanCompleted> {
    if (state.alreadyClean) {
      return {
        action: 'already-clean',
        domain: request.domain,
        version: request.version,
        tarball: state.tarball,
        platforms: state.selected,
        scan: publicScanResult(scan),
      }
    }
    return this.attestExisting(
      state.metadataKey,
      state.metadata,
      request,
      state.tarball,
      state.sha256,
      state.size,
      scan,
    )
  }

  private async readCleanAttestation(tarball: string, sha256: string): Promise<MalwareScanResult | null> {
    try {
      // The sidecar is the durable evidence written after the original clean
      // scan. It may repair metadata, but only while it remains digest-bound
      // and structurally valid; otherwise the retained bytes are scanned again.
      const parsed = JSON.parse(
        (await this.store.getObject(binaryAttestationKey(tarball))).toString('utf8'),
      ) as { scan?: Partial<MalwareScanResult> }
      const scan = parsed.scan
      if (
        scan?.verdict !== 'clean'
        || scan.artifactSha256 !== sha256
        || typeof scan.engine !== 'string'
        || scan.engine.trim().length === 0
        || typeof scan.scannedAt !== 'string'
        || !Number.isFinite(Date.parse(scan.scannedAt))
        || typeof scan.durationMs !== 'number'
        || !Number.isFinite(scan.durationMs)
        || scan.durationMs < 0
        || (scan.signature !== undefined && typeof scan.signature !== 'string')
        || (scan.engineVersion !== undefined && typeof scan.engineVersion !== 'string')
        || (scan.databaseVersion !== undefined && typeof scan.databaseVersion !== 'string')
        || (scan.reason !== undefined && typeof scan.reason !== 'string')
      ) {
        return null
      }
      return scan as MalwareScanResult
    }
    catch {
      return null
    }
  }

  private async attestExisting(
    metadataKey: string,
    metadata: BinaryPackageMetadata,
    request: BinaryRescanRequest,
    tarball: string,
    sha256: string,
    size: number,
    scan: MalwareScanResult,
  ): Promise<BinaryRescanCompleted> {
    const updatedAt = new Date(this.now()).toISOString()
    const records: Record<string, BinaryPlatformRecord> = {}
    for (const [version, versionInfo] of Object.entries(metadata.versions || {})) {
      for (const [platform, record] of Object.entries(versionInfo.platforms || {})) {
        if (storedBinaryKey(record.tarball) !== tarball) continue
        record.tarball = tarball
        record.sha256 = sha256
        record.size = size
        record.malwareScan = scan
        if (!record.uploadedAt) record.uploadedAt = updatedAt
        if (version === request.version) records[platform] = record
      }
    }
    await this.store.putObject(`${tarball}.sha256`, `${sha256}  ${tarball.split('/').at(-1)}\n`, 'text/plain')
    await this.store.putObject(binaryAttestationKey(tarball), JSON.stringify({
      domain: request.domain,
      version: request.version,
      platforms: Object.keys(records),
      filename: tarball.split('/').at(-1),
      scan,
    }), 'application/json')
    metadata.updatedAt = updatedAt
    await this.store.putObject(metadataKey, JSON.stringify(metadata, null, 2), 'application/json')

    const completed: BinaryPublishCompleted = {
      domain: request.domain,
      version: request.version,
      platforms: records,
      scan: publicScanResult(scan),
    }
    await this.options.onPublished?.(completed)
    return { action: 'attested', tarball, ...completed }
  }

  private async keepQuarantinedAfterReview(
    state: QuarantineReviewState,
    scan: MalwareScanResult,
  ): Promise<BinaryQuarantineReviewCompleted> {
    const reviewedAt = new Date(this.now()).toISOString()
    Object.assign(state.quarantine, {
      signature: scan.signature,
      engine: scan.engine,
      engineVersion: scan.engineVersion,
      databaseVersion: scan.databaseVersion,
      scannedAt: scan.scannedAt,
      reviewedAt,
      quarantineKey: state.quarantineKey,
      filename: state.filename,
      size: state.size,
    })
    state.metadata.updatedAt = reviewedAt
    await this.store.putObject(
      `${state.quarantineKey}.review-${reviewedAt.replaceAll(/[:.]/g, '-')}.json`,
      JSON.stringify({
        reviewedAt,
        domain: state.metadata.name,
        version: state.quarantine.version,
        platforms: state.quarantine.platforms,
        quarantineKey: state.quarantineKey,
        scan,
      }),
      'application/json',
    )
    await this.store.putObject(state.metadataKey, JSON.stringify(state.metadata, null, 2), 'application/json')
    return {
      action: 'still-quarantined',
      domain: state.metadata.name,
      version: state.quarantine.version,
      platforms: {},
      scan: publicScanResult(scan),
    }
  }

  private async releaseQuarantine(
    state: QuarantineReviewState,
    request: BinaryQuarantineReviewRequest,
    scan: MalwareScanResult,
  ): Promise<BinaryQuarantineReviewCompleted> {
    const releasedAt = new Date(this.now()).toISOString()
    const records: Record<string, BinaryPlatformRecord> = {}
    const otherQuarantines = state.metadata.malwareQuarantines?.filter(item =>
      item.version === request.version
      && item.artifactSha256 !== request.artifactSha256,
    ) || []
    for (const platform of state.quarantine.platforms) {
      if (otherQuarantines.some(item => item.platforms.includes(platform)))
        continue
      const tarball = `binaries/${request.domain}/${request.version}/${platform}/${state.filename}`
      await this.store.copyObject(state.quarantineKey, tarball)
      await this.store.putObject(`${tarball}.sha256`, `${request.artifactSha256}  ${state.filename}\n`, 'text/plain')
      await this.store.putObject(binaryAttestationKey(tarball), JSON.stringify({
        domain: request.domain,
        version: request.version,
        platform,
        filename: state.filename,
        source: 'quarantine-review',
        quarantineKey: state.quarantineKey,
        scan,
      }), 'application/json')
      records[platform] = {
        tarball,
        sha256: request.artifactSha256,
        size: state.size,
        uploadedAt: releasedAt,
        malwareScan: scan,
      }
    }

    state.metadata.versions ||= {}
    state.metadata.versions[request.version] ||= { platforms: {} }
    state.metadata.versions[request.version].platforms ||= {}
    Object.assign(state.metadata.versions[request.version].platforms, records)
    state.metadata.malwareQuarantines = state.metadata.malwareQuarantines?.filter(item =>
      item.version !== request.version
      || item.artifactSha256 !== request.artifactSha256,
    )
    if (state.metadata.malwareQuarantines?.length === 0)
      delete state.metadata.malwareQuarantines
    if (!state.metadata.latestVersion || newerVersion(request.version, state.metadata.latestVersion))
      state.metadata.latestVersion = request.version
    state.metadata.updatedAt = releasedAt
    await this.store.putObject(state.metadataKey, JSON.stringify(state.metadata, null, 2), 'application/json')

    const completed: BinaryPublishCompleted = {
      domain: request.domain,
      version: request.version,
      platforms: records,
      scan: publicScanResult(scan),
    }
    await this.options.onPublished?.(completed)
    return { action: 'released', ...completed }
  }

  private async quarantineExisting(
    metadataKey: string,
    metadata: BinaryPackageMetadata,
    request: BinaryRescanRequest,
    tarball: string,
    scan: MalwareScanResult,
  ): Promise<BinaryRescanCompleted> {
    const quarantineKey = `.pantry-quarantine/malware/${request.domain}/${request.version}/${scan.artifactSha256}/${tarball.split('/').at(-1)}`
    const quarantinedAt = new Date(this.now()).toISOString()
    await this.store.copyObject(tarball, quarantineKey)
    await this.store.putObject(`${quarantineKey}.scan.json`, JSON.stringify({
      quarantinedAt,
      originalKey: tarball,
      domain: request.domain,
      version: request.version,
      scan,
    }), 'application/json')

    const removedPlatforms = new Map<string, Set<string>>()
    let quarantinedSize: number | undefined
    for (const [version, versionInfo] of Object.entries(metadata.versions || {})) {
      for (const [platform, record] of Object.entries(versionInfo.platforms || {})) {
        if (storedBinaryKey(record.tarball) === tarball) {
          quarantinedSize ??= record.size
          const platforms = removedPlatforms.get(version) || new Set<string>()
          platforms.add(platform)
          removedPlatforms.set(version, platforms)
          delete versionInfo.platforms[platform]
        }
      }
      if (Object.keys(versionInfo.platforms || {}).length === 0)
        delete metadata.versions[version]
    }
    for (const [version, platforms] of removedPlatforms) {
      this.recordQuarantineTombstone(
        metadata,
        version,
        [...platforms],
        scan,
        quarantinedAt,
        {
          quarantineKey,
          filename: tarball.split('/').at(-1)!,
          size: quarantinedSize,
        },
      )
    }
    if (!metadata.versions[metadata.latestVersion]) {
      metadata.latestVersion = Object.keys(metadata.versions)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .at(0) || ''
    }
    metadata.updatedAt = quarantinedAt
    await this.store.putObject(metadataKey, JSON.stringify(metadata, null, 2), 'application/json')
    await this.store.deleteObject(tarball)
    await this.store.deleteObject(`${tarball}.sha256`).catch(() => {})
    await this.store.deleteObject(binaryAttestationKey(tarball)).catch(() => {})
    return {
      action: 'quarantined',
      domain: request.domain,
      version: request.version,
      tarball,
      platforms: {},
      scan: publicScanResult(scan),
    }
  }

  private async quarantineBlockedFallback(
    claim: StagingClaim,
    sealedKey: string,
    scan: MalwareScanResult,
  ): Promise<void> {
    const quarantinedAt = new Date(this.now()).toISOString()
    const quarantineKey = `.pantry-quarantine/malware/${claim.domain}/${claim.version}/${scan.artifactSha256}/${claim.filename}`
    await this.store.copyObject(sealedKey, quarantineKey)
    await this.store.putObject(`${quarantineKey}.scan.json`, JSON.stringify({
      quarantinedAt,
      originalKey: sealedKey,
      domain: claim.domain,
      version: claim.version,
      platforms: claim.platforms,
      source: 'pkgx',
      scan,
    }), 'application/json')

    await this.withDomainLock(claim.domain, async () => {
      const metadataKey = `binaries/${claim.domain}/metadata.json`
      let metadata: BinaryPackageMetadata = {
        name: claim.domain,
        latestVersion: '',
        versions: {},
        updatedAt: quarantinedAt,
      }
      try {
        metadata = JSON.parse(
          (await this.store.getObject(metadataKey)).toString('utf8'),
        ) as BinaryPackageMetadata
      }
      catch {}
      this.recordQuarantineTombstone(
        metadata,
        claim.version,
        claim.platforms,
        scan,
        quarantinedAt,
        {
          quarantineKey,
          filename: claim.filename,
          size: claim.size,
        },
      )
      metadata.updatedAt = quarantinedAt
      await this.store.putObject(metadataKey, JSON.stringify(metadata, null, 2), 'application/json')
    })
  }

  private recordQuarantineTombstone(
    metadata: BinaryPackageMetadata,
    version: string,
    platforms: string[],
    scan: MalwareScanResult,
    quarantinedAt: string,
    artifact: {
      quarantineKey: string
      filename: string
      size?: number
    },
  ): void {
    metadata.malwareQuarantines ||= []
    const existing = metadata.malwareQuarantines.find(
      quarantine => quarantine.version === version
        && quarantine.artifactSha256 === scan.artifactSha256,
    )
    if (existing) {
      existing.platforms = [...new Set([...existing.platforms, ...platforms])].sort()
      existing.quarantinedAt = quarantinedAt
      existing.quarantineKey = artifact.quarantineKey
      existing.filename = artifact.filename
      if (artifact.size !== undefined) existing.size = artifact.size
      return
    }
    metadata.malwareQuarantines.push({
      version,
      platforms: [...new Set(platforms)].sort(),
      artifactSha256: scan.artifactSha256,
      quarantineKey: artifact.quarantineKey,
      filename: artifact.filename,
      ...(artifact.size !== undefined ? { size: artifact.size } : {}),
      ...(scan.signature ? { signature: scan.signature } : {}),
      engine: scan.engine,
      ...(scan.engineVersion ? { engineVersion: scan.engineVersion } : {}),
      ...(scan.databaseVersion ? { databaseVersion: scan.databaseVersion } : {}),
      scannedAt: scan.scannedAt,
      quarantinedAt,
    })
  }

  /**
   * @param allowExpired Let a poll read a claim whose window has closed.
   *   Expiry exists to stop new work being authorized, not to hide work that
   *   already ran: the signature is still valid, so the claim still says
   *   truthfully which artifact this was. complete() re-checks expiry itself,
   *   after looking for a result, so an expired claim can still collect a
   *   verdict it waited an hour for but cannot start anything.
   */
  private verifyClaim(uploadId: string, options: { allowExpired?: boolean } = {}): StagingClaim {
    const [payload, signature, extra] = uploadId.split('.')
    if (!payload || !signature || extra || !safeEqual(signClaim(payload, this.options.tokenSecret), signature))
      throw new BinaryPublishError('Invalid binary staging upload ID', 401, 'INVALID_BINARY_UPLOAD_ID')

    let claim: unknown
    try {
      claim = JSON.parse(unbase64url(payload))
    }
    catch {
      throw new BinaryPublishError('Invalid binary staging upload ID', 401, 'INVALID_BINARY_UPLOAD_ID')
    }
    const request = validateBinaryPublishRequest(claim, this.maxBytes)
    const value = claim as Partial<StagingClaim>
    if (typeof value.stagingKey !== 'string' || !value.stagingKey.startsWith(`${STAGING_PREFIX}/`) || typeof value.expiresAt !== 'number')
      throw new BinaryPublishError('Invalid binary staging upload ID', 401, 'INVALID_BINARY_UPLOAD_ID')
    if (!options.allowExpired && value.expiresAt < this.now())
      throw new BinaryPublishError('Binary staging upload has expired', 410, 'BINARY_UPLOAD_EXPIRED')
    return { ...request, stagingKey: value.stagingKey, expiresAt: value.expiresAt }
  }

  private async promote(
    claim: StagingClaim,
    sealedKey: string,
    scan: MalwareScanResult,
  ): Promise<BinaryPublishCompleted> {
    const uploadedAt = new Date(this.now()).toISOString()
    const records: Record<string, BinaryPlatformRecord> = {}
    for (const platform of claim.platforms) {
      const tarball = `binaries/${claim.domain}/${claim.version}/${platform}/${claim.filename}`
      await this.store.copyObject(sealedKey, tarball)
      await this.store.putObject(`${tarball}.sha256`, `${claim.sha256}  ${claim.filename}\n`, 'text/plain')
      await this.store.putObject(binaryAttestationKey(tarball), JSON.stringify({
        domain: claim.domain,
        version: claim.version,
        platform,
        filename: claim.filename,
        scan,
      }), 'application/json')
      records[platform] = {
        tarball,
        sha256: claim.sha256,
        size: claim.size,
        uploadedAt,
        malwareScan: scan,
      }
    }

    const metadataKey = `binaries/${claim.domain}/metadata.json`
    let metadata: BinaryPackageMetadata = {
      name: claim.domain,
      latestVersion: claim.version,
      versions: {},
      updatedAt: uploadedAt,
    }
    try {
      metadata = JSON.parse((await this.store.getObject(metadataKey)).toString('utf8')) as BinaryPackageMetadata
    }
    catch {}
    metadata.name = claim.domain
    metadata.versions ||= {}
    metadata.versions[claim.version] ||= { platforms: {} }
    metadata.versions[claim.version].platforms ||= {}
    Object.assign(metadata.versions[claim.version].platforms, records)
    if (!metadata.latestVersion || newerVersion(claim.version, metadata.latestVersion))
      metadata.latestVersion = claim.version
    metadata.updatedAt = uploadedAt
    await this.store.putObject(metadataKey, JSON.stringify(metadata, null, 2), 'application/json')

    return {
      domain: claim.domain,
      version: claim.version,
      platforms: records,
      scan: publicScanResult(scan),
    }
  }

  private async findCompleted(claim: StagingClaim): Promise<BinaryPublishCompleted | null> {
    try {
      const metadata = JSON.parse(
        (await this.store.getObject(`binaries/${claim.domain}/metadata.json`)).toString('utf8'),
      ) as BinaryPackageMetadata
      const records: Record<string, BinaryPlatformRecord> = {}
      for (const platform of claim.platforms) {
        const record = metadata.versions?.[claim.version]?.platforms?.[platform]
        if (!record || record.sha256 !== claim.sha256 || record.malwareScan?.verdict !== 'clean')
          return null
        records[platform] = record
      }
      const scan = records[claim.platforms[0]].malwareScan
      return { domain: claim.domain, version: claim.version, platforms: records, scan: publicScanResult(scan) }
    }
    catch {
      return null
    }
  }

  private async withDomainLock<T>(domain: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(domain) || Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => release = resolve)
    const chain = previous.then(() => next)
    this.locks.set(domain, chain)
    await previous
    try {
      return await action()
    }
    finally {
      release()
      if (this.locks.get(domain) === chain)
        this.locks.delete(domain)
    }
  }
}

export function binaryPublishErrorResponse(
  error: BinaryPublishError,
  headers: Record<string, string> = {},
): Response {
  return Response.json({
    error: error.message,
    code: error.code,
    retryable: error.status === 503,
    scan: error.scan ? publicScanResult(error.scan) : undefined,
  }, {
    status: error.status,
    headers: error.status === 503 ? { ...headers, 'Retry-After': '60' } : headers,
  })
}
