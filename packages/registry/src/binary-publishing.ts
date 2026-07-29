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
  scanPackageArtifact,
  scanPackageArtifactStream,
  type MalwareScanResult,
  type MalwareScanner,
  type PublishSurface,
} from './malware-scanning'

const DEFAULT_MAX_BINARY_BYTES = 1024 * 1024 * 1024
const DEFAULT_STAGING_TTL_SECONDS = 60 * 60
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
  stagingTtlSeconds?: number
  now?: () => number
  onPublished?: (result: BinaryPublishCompleted) => Promise<void>
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

export class BinaryArtifactPublisher {
  private maxBytes: number
  private stagingTtlSeconds: number
  private now: () => number
  private locks = new Map<string, Promise<void>>()

  constructor(
    private store: BinaryArtifactStore,
    private scanner: MalwareScanner,
    private options: BinaryArtifactPublisherOptions,
  ) {
    if (!options.tokenSecret || options.tokenSecret.length < 16)
      throw new Error('binary staging token secret must contain at least 16 characters')
    this.maxBytes = options.maxBytes || DEFAULT_MAX_BINARY_BYTES
    this.stagingTtlSeconds = options.stagingTtlSeconds || DEFAULT_STAGING_TTL_SECONDS
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

  async complete(
    uploadId: string,
    publisher?: string,
    surface: Extract<PublishSurface, 'binary' | 'pkgx'> = 'binary',
  ): Promise<BinaryPublishCompleted> {
    const claim = this.verifyClaim(uploadId)
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

    if (!stagingExists) {
      const existing = await this.findCompleted(claim)
      if (existing) return existing
      throw new BinaryPublishError('Staged artifact was not found or has expired', 404, 'BINARY_STAGING_NOT_FOUND')
    }

    try {
      // Seal the object before scanning. The presigned URL can write only the
      // original staging key, so a retry/overwrite cannot race the scan and the
      // subsequent server-side promotion.
      await this.store.copyObject(claim.stagingKey, sealedKey)
      await this.store.deleteObject(claim.stagingKey)

      const context = {
        surface,
        name: claim.domain,
        version: claim.version,
        publisher,
      } as const
      let scan: MalwareScanResult
      if (this.store.getObjectStream && this.scanner.scanStream) {
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
      if (scan.verdict === 'blocked')
        throw new BinaryPublishError('Binary artifact blocked by malware scanning', 422, 'MALWARE_DETECTED', scan)
      if (scan.verdict === 'review')
        throw new BinaryPublishError('Binary artifact requires security review', 202, 'PACKAGE_REQUIRES_REVIEW', scan)
      if (scan.verdict !== 'clean')
        throw new BinaryPublishError('Binary artifact malware scanning is temporarily unavailable', 503, 'MALWARE_SCAN_UNAVAILABLE', scan)

      const completed = await this.withDomainLock(claim.domain, () => this.promote(claim, sealedKey, scan))
      await this.options.onPublished?.(completed)
      return completed
    }
    finally {
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
    return this.complete(initiated.uploadId, publisher, surface)
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
    if (this.store.getObjectStream && this.scanner.scanStream) {
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
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.maxBytes)
      throw new BinaryPublishError(`Retained binary artifact size must be between 1 and ${this.maxBytes} bytes`, 413, 'INVALID_BINARY_SIZE')

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

  private async quarantineExisting(
    metadataKey: string,
    metadata: BinaryPackageMetadata,
    request: BinaryRescanRequest,
    tarball: string,
    scan: MalwareScanResult,
  ): Promise<BinaryRescanCompleted> {
    const quarantineKey = `.pantry-quarantine/malware/${request.domain}/${request.version}/${scan.artifactSha256}/${tarball.split('/').at(-1)}`
    await this.store.copyObject(tarball, quarantineKey)
    await this.store.putObject(`${quarantineKey}.scan.json`, JSON.stringify({
      quarantinedAt: new Date(this.now()).toISOString(),
      originalKey: tarball,
      domain: request.domain,
      version: request.version,
      scan,
    }), 'application/json')

    for (const [version, versionInfo] of Object.entries(metadata.versions || {})) {
      for (const [platform, record] of Object.entries(versionInfo.platforms || {})) {
        if (storedBinaryKey(record.tarball) === tarball)
          delete versionInfo.platforms[platform]
      }
      if (Object.keys(versionInfo.platforms || {}).length === 0)
        delete metadata.versions[version]
    }
    if (!metadata.versions[metadata.latestVersion]) {
      metadata.latestVersion = Object.keys(metadata.versions)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .at(0) || ''
    }
    metadata.updatedAt = new Date(this.now()).toISOString()
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

  private verifyClaim(uploadId: string): StagingClaim {
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
    if (value.expiresAt < this.now())
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
