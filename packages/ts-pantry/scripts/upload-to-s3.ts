#!/usr/bin/env bun

/**
 * Upload Package Binaries to object storage
 *
 * Uploads built package tarballs to the registry bucket on the configured
 * object-storage provider (AWS S3, Backblaze B2 or Hetzner). Set STORAGE_PROVIDER
 * (+ the provider's endpoint/region/credential env vars) to target B2/Hetzner;
 * defaults to AWS S3. Uses ts-cloud for the S3-compatible client.
 */

import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import { createObjectStorageClient } from '@stacksjs/ts-cloud'

const DYNAMO_TABLE = process.env.DYNAMODB_TABLE || 'pantry-packages'

/**
 * Tarballs at/above this size are uploaded via a presigned PUT URL streamed
 * with curl instead of putObject. putObject reads the whole file into memory
 * and posts a single in-memory request, which hangs / OOMs for large desktop
 * apps (e.g. Dia is ~710MB). A presigned PUT lets curl stream the file straight
 * from disk — memory stays flat and S3 accepts a single object up to 5GB.
 *
 * (ts-cloud's S3 multipart API can't be used here: its createMultipartUpload
 * initiates path-style while uploadPart targets the virtual-host endpoint, so on
 * Hetzner the part upload 404s with NoSuchUpload. The presigned single-PUT path
 * sidesteps that entirely and works on every S3-compatible provider.)
 */
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024 // 100 MB

/**
 * Upload a tarball to S3, streaming large files via a presigned PUT + curl.
 *
 * - Small files (< {@link LARGE_FILE_THRESHOLD}): single putObject (existing path).
 * - Large files: presign a PUT URL (works against the provider's real,
 *   virtual-host endpoint) and `curl -T` the file from disk so it never lands in
 *   JS memory. The presigned URL signs UNSIGNED-PAYLOAD with host-only headers,
 *   so curl must send no extra signed headers.
 */
async function uploadTarballToS3(
  s3: ReturnType<typeof createObjectStorageClient>,
  bucket: string,
  key: string,
  filePath: string,
  size: number,
  contentType: string,
): Promise<void> {
  // Always upload via a presigned PUT + curl. The plain `s3.putObject` SigV4 PUT
  // silently fails on GitHub's macOS runners (no error, object not written), so
  // a small macOS-built app would otherwise log success while publishing
  // nothing. curl `-fsS` fails loudly on any 4xx/5xx. (contentType is unused —
  // the presigned signature covers host only; serving sets the type.)
  void contentType
  if (size >= LARGE_FILE_THRESHOLD)
    console.log(`   ⛓  Large file (${(size / 1024 / 1024).toFixed(0)} MB) — streaming via presigned PUT`)
  // -T streams the file from disk; -f fails on any HTTP 4xx/5xx so the caller's
  // try/catch sees it. No Content-Type header: the presigned signature covers
  // host only, and an unsigned header can break the sig.
  // --speed-limit/--speed-time abort a stalled connection (Hetzner occasionally
  // hangs a PUT) after 60s below 1KB/s instead of waiting out --max-time; --retry
  // then re-presigns+reconnects, so an intermittent stall self-heals rather than
  // blocking for the full hour. We re-presign per attempt because a presigned URL
  // can't be replayed after a partial PUT.
  const maxAttempts = 4
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const url = await s3.getSignedUrl({ bucket, key, expiresIn: 3600, operation: 'putObject' })
    try {
      // No --max-time: large apps on a slow uplink (Dia ~710MB) can legitimately
      // take well over an hour. --speed-limit/--speed-time already abort a genuine
      // stall (under 1KB/s for 60s), so a slow-but-steady transfer is allowed to
      // run to completion rather than being cut off by a wall-clock ceiling.
      execFileSync('curl', [
        '-fsS', '--connect-timeout', '30',
        '--speed-limit', '1024', '--speed-time', '120',
        '-X', 'PUT', '-T', filePath, url,
      ], { stdio: ['ignore', 'ignore', 'inherit'] })
      return
    }
    catch (err) {
      if (attempt === maxAttempts)
        throw err
      console.log(`   ↻ upload attempt ${attempt} failed/stalled — retrying (${attempt + 1}/${maxAttempts})`)
    }
  }
}

/**
 * PUT a small in-memory object (e.g. metadata.json) via a presigned URL + curl,
 * the same path large tarballs use. The plain `s3.putObject` SigV4 PUT silently
 * fails on GitHub's macOS runners (no error thrown, but the object isn't
 * written), which left macOS-built apps like cursor/transmit with an uploaded
 * tarball but a stale metadata.json. `curl -fsS` fails loudly on any 4xx/5xx so
 * a real failure surfaces. Returns true on success.
 */
async function putBufferViaPresigned(
  s3: ReturnType<typeof createObjectStorageClient>,
  bucket: string,
  key: string,
  body: string,
): Promise<void> {
  const tmp = join(tmpdir(), `pantry-put-${process.pid}-${key.replace(/[^a-z0-9]+/gi, '-')}`)
  writeFileSync(tmp, body)
  try {
    const url = await s3.getSignedUrl({ bucket, key, expiresIn: 3600, operation: 'putObject' })
    // No Content-Type header — the presigned signature covers host only, and an
    // unsigned header can break the signature (same as the tarball path).
    execFileSync('curl', ['-fsS', '--connect-timeout', '30', '-X', 'PUT', '-T', tmp, url], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  }
  finally {
    try { rmSync(tmp) }
    catch {}
  }
}

/** SHA256 of a file, streamed from disk (no full read into memory). */
async function sha256File2(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

export interface UploadOptions {
  package: string
  version: string
  artifactsDir: string
  bucket: string
  region: string
  /**
   * Optional explicit list of registry platform keys (e.g. ['darwin-arm64',
   * 'darwin-x86-64']) to publish each discovered artifact under, overriding the
   * platform parsed from the artifact directory name. Used for platform-agnostic
   * desktop apps/fonts that are built on a single (e.g. ubuntu) runner but must
   * be installable on the platforms their recipe targets — the CLI's registry
   * lookup only matches the host's own `darwin-<arch>` key, so a `linux-x86-64`
   * upload would be invisible to macOS clients.
   */
  platforms?: string[]
}

interface PackageMetadata {
  name: string
  latestVersion: string
  versions: Record<string, {
    platforms: Record<string, {
      tarball: string
      sha256: string
      size: number
      uploadedAt: string
    }>
  }>
  updatedAt: string
}

async function dynamoRequest(action: string, params: Record<string, unknown>, region: string): Promise<unknown> {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS credentials not found for DynamoDB sync')
  }

  const host = `dynamodb.${region}.amazonaws.com`
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)

  const payload = JSON.stringify(params)
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex')

  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.0',
    'x-amz-target': `DynamoDB_20120810.${action}`,
    'host': host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  }

  if (process.env.AWS_SESSION_TOKEN) {
    headers['x-amz-security-token'] = process.env.AWS_SESSION_TOKEN
  }

  const signedHeaderKeys = Object.keys(headers).sort()
  const signedHeadersStr = signedHeaderKeys.join(';')
  const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('')

  const canonicalRequest = [
    'POST', '/', '', canonicalHeaders, signedHeadersStr, payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${region}/dynamodb/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')

  const hmac = (key: Buffer | string, data: string) =>
    crypto.createHmac('sha256', key).update(data).digest()

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, 'dynamodb')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`

  const response = await fetch(`https://${host}/`, {
    method: 'POST',
    headers,
    body: payload,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`DynamoDB ${action} failed: ${response.status} ${text}`)
  }

  return response.json()
}

async function syncToDynamoDB(pkgName: string, version: string, availableVersions: string[], region: string): Promise<void> {
  const safeName = pkgName.replace(/[^a-zA-Z0-9.-]/g, '-')

  await dynamoRequest('UpdateItem', {
    TableName: DYNAMO_TABLE,
    Key: {
      packageName: { S: pkgName },
    },
    UpdateExpression: 'SET latestVersion = :v, s3Path = :s, safeName = :sn, updatedAt = :u, availableVersions = :av',
    ExpressionAttributeValues: {
      ':v': { S: version },
      ':s': { S: `binaries/${pkgName}/metadata.json` },
      ':sn': { S: safeName },
      ':u': { S: new Date().toISOString() },
      ':av': { L: availableVersions.map(v => ({ S: v })) },
    },
  }, region)
}

function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) => {
    const dashIdx = v.indexOf('-')
    const numeric = (dashIdx === -1 ? v : v.slice(0, dashIdx)).split('.').map(s => {
      const n = Number.parseInt(s, 10)
      return Number.isNaN(n) ? 0 : n
    })
    const prerelease = dashIdx === -1 ? null : v.slice(dashIdx + 1)
    return { numeric, prerelease }
  }
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.numeric.length, pb.numeric.length)
  for (let i = 0; i < len; i++) {
    const av = pa.numeric[i] ?? 0
    const bv = pb.numeric[i] ?? 0
    if (av !== bv) return av > bv
  }
  // Same numeric: release (no prerelease) is newer than prerelease
  if (pa.prerelease === null && pb.prerelease !== null) return true
  if (pa.prerelease !== null && pb.prerelease === null) return false
  // Both have prerelease: compare lexicographically
  if (pa.prerelease !== null && pb.prerelease !== null) return pa.prerelease > pb.prerelease
  return false
}

function compareSemverDesc(a: string, b: string): number {
  if (isNewerVersion(a, b)) return -1
  if (isNewerVersion(b, a)) return 1
  return 0
}

export async function uploadToS3(options: UploadOptions): Promise<void> {
  const { package: pkgName, version, artifactsDir, bucket, region } = options
  const platformOverride = options.platforms && options.platforms.length > 0 ? options.platforms : null
  const provider = (process.env.STORAGE_PROVIDER || 'aws') as 'aws' | 'backblaze' | 'hetzner'

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Uploading ${pkgName} ${version} to object storage`)
  console.log(`${'='.repeat(60)}`)
  console.log(`   Provider: ${provider}`)
  console.log(`   Bucket: ${bucket}`)
  console.log(`   Region: ${region}`)

  // Initialize the S3-compatible client. For AWS, honor the --region flag;
  // for B2/Hetzner the region/endpoint/credentials come from env (resolved by ts-cloud).
  const s3 = createObjectStorageClient({ provider, region: provider === 'aws' ? region : undefined })

  // Find all artifact directories
  if (!existsSync(artifactsDir)) {
    throw new Error(`Artifacts directory not found: ${artifactsDir}`)
  }

  const artifactDirs = readdirSync(artifactsDir).filter(name => {
    const fullPath = join(artifactsDir, name)
    return statSync(fullPath).isDirectory()
  })

  if (artifactDirs.length === 0) {
    throw new Error('No artifact directories found')
  }

  console.log(`\n📦 Found ${artifactDirs.length} artifacts to upload`)

  // S3 key structure: packages/pantry/{domain}/{version}/{platform}/{filename}
  const uploadedPlatforms: Record<string, {
    tarball: string
    sha256: string
    size: number
  }> = {}

  for (const artifactDir of artifactDirs) {
    const artifactPath = join(artifactsDir, artifactDir)
    const files = readdirSync(artifactPath)

    // Find tarball and sha256 files
    const expectedTarball = `${pkgName.replace(/\//g, '-')}-${version}.tar.gz`
    const tarball = files.find(f => f.endsWith('.tar.gz'))
    const sha256File = files.find(f => f === `${expectedTarball}.sha256`)

    if (!tarball) {
      console.log(`⚠️  No tarball found in ${artifactDir}, skipping`)
      continue
    }
    if (tarball !== expectedTarball) {
      console.log(`⚠️  Expected ${expectedTarball} in ${artifactDir}, found ${tarball}; skipping stale artifact`)
      continue
    }

    // Extract platform from artifact name (e.g., "php-net-8.4.11-darwin-arm64").
    // A --platforms override replaces this (a platform-agnostic desktop/font
    // artifact built on one runner gets registered under every target platform).
    const match = artifactDir.match(/-(darwin|linux)-(arm64|x86-64)$/)
    if (!match && !platformOverride) {
      console.log(`⚠️  Could not determine platform from ${artifactDir}, skipping`)
      continue
    }
    const targetPlatforms = platformOverride ?? [`${match![1]}-${match![2]}`]

    // Stream the tarball from disk (don't slurp the whole file into memory —
    // large desktop apps like Dia are ~710MB). uploadTarballToS3 reads it in
    // chunks for multipart, putObject for small files.
    const tarballPath = join(artifactPath, tarball)
    const tarballSize = statSync(tarballPath).size

    // Calculate SHA256 if not provided (stream it; never hold the file in memory).
    let sha256Hash: string
    if (sha256File) {
      const sha256Content = readFileSync(join(artifactPath, sha256File), 'utf-8')
      sha256Hash = sha256Content.split(' ')[0].trim()
    }
else {
      sha256Hash = await sha256File2(tarballPath)
    }

    for (const platform of targetPlatforms) {
      console.log(`\n📤 Uploading ${platform}...`)

      // S3 keys
      const tarballKey = `binaries/${pkgName}/${version}/${platform}/${tarball}`
      const sha256Key = `binaries/${pkgName}/${version}/${platform}/${tarball}.sha256`

      // Upload tarball (multipart for large files, single PutObject otherwise)
      console.log(`   📁 Uploading ${tarball} (${(tarballSize / 1024 / 1024).toFixed(2)} MB)`)
      await uploadTarballToS3(s3, bucket, tarballKey, tarballPath, tarballSize, 'application/gzip')
      console.log(`   ✓ Uploaded to s3://${bucket}/${tarballKey}`)

      // Upload SHA256 (presigned PUT — plain putObject is unreliable on macOS).
      await putBufferViaPresigned(s3, bucket, sha256Key, `${sha256Hash}  ${tarball}\n`)
      console.log(`   ✓ Uploaded SHA256`)

      uploadedPlatforms[platform] = {
        tarball: tarballKey,
        sha256: sha256Hash,
        size: tarballSize,
      }
    }
  }

  if (Object.keys(uploadedPlatforms).length === 0) {
    throw new Error(`No matching artifacts found for ${pkgName}@${version}`)
  }

  // Update metadata
  console.log(`\n📊 Updating package metadata...`)

  const metadataKey = `binaries/${pkgName}/metadata.json`
  let metadata: PackageMetadata

  try {
    const existingMetadata = await s3.getObject(bucket, metadataKey)
    metadata = JSON.parse(existingMetadata)
    console.log(`   Found existing metadata`)
  }
catch {
    // Create new metadata
    metadata = {
      name: pkgName,
      latestVersion: version,
      versions: {},
      updatedAt: new Date().toISOString(),
    }
    console.log(`   Creating new metadata`)
  }

  // Update version info
  if (!metadata.versions[version]) {
    metadata.versions[version] = { platforms: {} }
  }

  for (const [platform, info] of Object.entries(uploadedPlatforms)) {
    metadata.versions[version].platforms[platform] = {
      tarball: info.tarball,
      sha256: info.sha256,
      size: info.size,
      uploadedAt: new Date().toISOString(),
    }
  }

  // Only update latestVersion if this version is newer
  if (!metadata.latestVersion || isNewerVersion(version, metadata.latestVersion)) {
    metadata.latestVersion = version
  }
  metadata.updatedAt = new Date().toISOString()

  // Upload metadata JSON via the presigned-PUT path (plain putObject silently
  // fails on macOS runners — see putBufferViaPresigned).
  await putBufferViaPresigned(s3, bucket, metadataKey, JSON.stringify(metadata, null, 2))
  console.log(`   ✓ Updated metadata at s3://${bucket}/${metadataKey}`)

  // Sync to DynamoDB so the Zig CLI can discover this package. DynamoDB is
  // AWS-only; when storage runs on B2/Hetzner, package discovery comes from the
  // bucket's per-package metadata.json instead, so skip the sync.
  if (provider === 'aws') {
    console.log(`\n📊 Syncing to DynamoDB registry...`)
    try {
      const availableVersions = Object.keys(metadata.versions).sort((a, b) => {
        return compareSemverDesc(a, b)
      })
      await syncToDynamoDB(pkgName, metadata.latestVersion, availableVersions, region)
      console.log(`   ✓ Updated DynamoDB (${DYNAMO_TABLE}) — ${availableVersions.length} versions`)
    }
    catch (error: any) {
      console.log(`   ⚠ DynamoDB sync failed (non-fatal): ${error.message}`)
    }
  }
  else {
    console.log(`\n📊 Skipping DynamoDB sync (provider=${provider}); discovery via bucket metadata.json`)
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Upload complete!`)
  console.log(`${'='.repeat(60)}`)
  console.log(`\n📦 ${pkgName}@${version}`)
  console.log(`   Platforms: ${Object.keys(uploadedPlatforms).join(', ')}`)
  console.log(`   Metadata: s3://${bucket}/${metadataKey}`)
}

// CLI entry point
async function main() {
  const { values } = parseArgs({
    options: {
      package: { type: 'string', short: 'p' },
      version: { type: 'string', short: 'v' },
      'artifacts-dir': { type: 'string' },
      bucket: { type: 'string', short: 'b' },
      region: { type: 'string', short: 'r', default: 'us-east-1' },
      platforms: { type: 'string' },
    },
    strict: true,
  })

  if (!values.package || !values.version || !values['artifacts-dir'] || !values.bucket) {
    console.error('Usage: upload-to-s3.ts --package <domain> --version <version> --artifacts-dir <dir> --bucket <bucket> [--region <region>]')
    console.error('Example: upload-to-s3.ts --package php.net --version 8.4.11 --artifacts-dir ./artifacts --bucket pantry-registry')
    process.exit(1)
  }

  await uploadToS3({
    package: values.package,
    version: values.version,
    artifactsDir: values['artifacts-dir'],
    bucket: values.bucket,
    region: values.region || 'us-east-1',
    platforms: values.platforms ? values.platforms.split(',').map(s => s.trim()).filter(Boolean) : undefined,
  })
}

// Only run CLI when executed directly (not when imported)
const isDirectRun = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('upload-to-s3.ts')
if (isDirectRun) {
  main().catch((error) => {
    console.error('❌ Upload failed:', error.message)
    process.exit(1)
  })
}
