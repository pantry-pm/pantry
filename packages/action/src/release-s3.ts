import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as exec from '@actions/exec'
import type { ReleaseManifest } from './release-manifest'
import { sha256File } from './release-manifest'

export type S3ReleaseProvider = 'aws' | 'backblaze' | 'hetzner'

export interface S3ReleaseOptions {
  provider: S3ReleaseProvider
  bucket: string
  region: string
  endpoint: string
  prefix: string
  publicUrl: string
  forcePathStyle: boolean
  cacheControl: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  dryRun: boolean
}

export interface S3ReleaseReceipt {
  schemaVersion: 1
  provider: S3ReleaseProvider
  bucket: string
  prefix: string
  tag: string
  dryRun: boolean
  objects: Array<{
    name: string
    key: string
    size: number
    sha256: string
    contentType: string
    cacheControl: string
    url?: string
  }>
}

interface MirrorDependencies {
  presign?: (options: S3ReleaseOptions, key: string, operation: 'getObject' | 'putObject') => string
  upload?: (file: string, url: string, cacheControl: string, contentType: string) => Promise<void>
  headSize?: (url: string) => Promise<number | undefined>
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

export function releaseObjectKey(prefix: string, tag: string, name: string): string {
  return [trimSlashes(prefix), trimSlashes(tag), path.basename(name)].filter(Boolean).join('/')
}

export function releasePublicUrl(baseUrl: string, key: string): string | undefined {
  const base = baseUrl.replace(/\/+$/g, '')
  return base ? `${base}/${key.split('/').map(encodeURIComponent).join('/')}` : undefined
}

export function releaseContentType(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.json'))
    return 'application/json'
  if (lower.endsWith('.pkg'))
    return 'application/vnd.apple.installer+xml'
  if (lower.endsWith('.zip'))
    return 'application/zip'
  if (lower.endsWith('.dmg'))
    return 'application/x-apple-diskimage'
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz'))
    return 'application/gzip'
  if (lower.endsWith('.md') || lower.endsWith('.txt'))
    return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

async function uploadWithCurl(file: string, url: string, cacheControl: string, contentType: string): Promise<void> {
  const result = await exec.exec('curl', [
    '-fsS',
    '--connect-timeout',
    '30',
    '--speed-limit',
    '1024',
    '--speed-time',
    '120',
    '-X',
    'PUT',
    '-H',
    `Cache-Control: ${cacheControl || 'public, max-age=31536000, immutable'}`,
    '-H',
    `Content-Type: ${contentType}`,
    '-T',
    file,
    url,
  ])
  if (result !== 0)
    throw new Error(`curl exited with status ${result}`)
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function hmac(key: string | Buffer, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value).digest()
}

function providerEndpoint(options: S3ReleaseOptions): string {
  const configured = options.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (configured)
    return configured
  if (options.provider === 'hetzner')
    return `${options.region || 'fsn1'}.your-objectstorage.com`
  if (options.provider === 'backblaze')
    return `s3.${options.region}.backblazeb2.com`
  return options.region && options.region !== 'us-east-1'
    ? `s3.${options.region}.amazonaws.com`
    : 's3.amazonaws.com'
}

export function presignS3Url(
  options: S3ReleaseOptions,
  key: string,
  operation: 'getObject' | 'putObject',
  now: Date = new Date(),
): string {
  const region = options.region || (options.provider === 'aws' ? 'us-east-1' : '')
  if (!region)
    throw new Error(`S3 region is required for ${options.provider}`)
  const endpoint = providerEndpoint(options)
  const host = options.forcePathStyle ? endpoint : `${options.bucket}.${endpoint}`
  const objectPath = key.split('/').map(encode).join('/')
  const pathname = options.forcePathStyle
    ? `/${encode(options.bucket)}/${objectPath}`
    : `/${objectPath}`
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = amzDate.slice(0, 8)
  const scope = `${date}/${region}/s3/aws4_request`
  const parameters: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${options.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '3600',
    'X-Amz-SignedHeaders': 'host',
  }
  if (options.sessionToken)
    parameters['X-Amz-Security-Token'] = options.sessionToken
  const query = Object.entries(parameters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .join('&')
  const canonicalRequest = [
    operation === 'putObject' ? 'PUT' : 'GET',
    pathname,
    query,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, date), region), 's3'),
    'aws4_request',
  )
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return `https://${host}${pathname}?${query}&X-Amz-Signature=${signature}`
}

async function headSizeWithCurl(url: string): Promise<number | undefined> {
  let stdout = ''
  const result = await exec.exec('curl', ['-fsS', '--range', '0-0', '--dump-header', '-', '--output', '/dev/null', url], {
    silent: true,
    listeners: {
      stdout: (data: Buffer) => { stdout += data.toString() },
    },
  })
  if (result !== 0)
    throw new Error(`curl verification exited with status ${result}`)
  const contentRange = stdout.match(/^content-range:\s*bytes\s+\d+-\d+\/(\d+)\s*$/im)
  if (contentRange)
    return Number(contentRange[1])
  const match = stdout.match(/^content-length:\s*(\d+)\s*$/im)
  return match ? Number(match[1]) : undefined
}

async function uploadReliably(
  options: S3ReleaseOptions,
  key: string,
  file: string,
  presign: (options: S3ReleaseOptions, key: string, operation: 'getObject' | 'putObject') => string,
  upload: (file: string, url: string, cacheControl: string, contentType: string) => Promise<void>,
  headSize: (url: string) => Promise<number | undefined>,
  cacheControl: string,
  contentType: string,
): Promise<void> {
  const size = fs.statSync(file).size
  let lastError: unknown

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const url = presign(options, key, 'putObject')
      await upload(file, url, cacheControl, contentType)
      const remoteSize = await headSize(presign(options, key, 'getObject'))
      if (remoteSize !== undefined && remoteSize !== size)
        throw new Error(`uploaded size ${remoteSize} does not match local size ${size}`)
      return
    }
    catch (error) {
      lastError = error
      if (attempt < 4)
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)))
    }
  }

  throw lastError
}

export async function mirrorReleaseToS3(options: {
  config: S3ReleaseOptions
  manifest: ReleaseManifest
  manifestFile: string
  releaseNotes: string
  files: string[]
}, dependencies: MirrorDependencies = {}): Promise<S3ReleaseReceipt> {
  const { config, manifest } = options
  if (!config.bucket)
    throw new Error('S3 release mirror requires a bucket')
  if (!config.dryRun && (!config.accessKeyId || !config.secretAccessKey))
    throw new Error('S3 release mirror requires an access key ID and secret access key')

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-release-s3-'))
  const notesFile = path.join(temporaryDirectory, 'CHANGELOG.md')
  const latestFile = path.join(temporaryDirectory, 'latest.json')
  fs.writeFileSync(notesFile, `${options.releaseNotes.trim()}\n`)

  const prefix = trimSlashes(config.prefix)
  const sourceFiles = [...options.files, options.manifestFile, notesFile]
  const receipt: S3ReleaseReceipt = {
    schemaVersion: 1,
    provider: config.provider,
    bucket: config.bucket,
    prefix,
    tag: manifest.tag,
    dryRun: config.dryRun,
    objects: sourceFiles.map((file) => {
      const name = file === notesFile ? 'CHANGELOG.md' : path.basename(file)
      const key = releaseObjectKey(prefix, manifest.tag, name)
      return {
        name,
        key,
        size: fs.statSync(file).size,
        sha256: sha256File(file),
        contentType: releaseContentType(name),
        cacheControl: config.cacheControl,
        url: releasePublicUrl(config.publicUrl, key),
      }
    }),
  }

  const latest = {
    schemaVersion: 1,
    repository: manifest.repository,
    tag: manifest.tag,
    commit: manifest.commit,
    manifest: releasePublicUrl(config.publicUrl, releaseObjectKey(prefix, manifest.tag, path.basename(options.manifestFile)))
      || releaseObjectKey(prefix, manifest.tag, path.basename(options.manifestFile)),
    updatedAt: manifest.generatedAt,
  }
  fs.writeFileSync(latestFile, `${JSON.stringify(latest, null, 2)}\n`)
  const latestKey = [prefix, 'latest.json'].filter(Boolean).join('/')
  receipt.objects.push({
    name: 'latest.json',
    key: latestKey,
    size: fs.statSync(latestFile).size,
    sha256: sha256File(latestFile),
    contentType: releaseContentType('latest.json'),
    cacheControl: 'no-cache',
    url: releasePublicUrl(config.publicUrl, latestKey),
  })

  try {
    if (!config.dryRun) {
      const presign = dependencies.presign || presignS3Url
      const upload = dependencies.upload || uploadWithCurl
      const headSize = dependencies.headSize || headSizeWithCurl
      for (const object of receipt.objects) {
        const file = object.name === 'latest.json'
          ? latestFile
          : object.name === 'CHANGELOG.md'
            ? notesFile
            : sourceFiles.find(candidate => path.basename(candidate) === object.name)
        if (!file)
          throw new Error(`Unable to resolve local release object ${object.name}`)
        await uploadReliably(
          config,
          object.key,
          file,
          presign,
          upload,
          headSize,
          object.cacheControl,
          object.contentType,
        )
      }
    }
    return receipt
  }
  finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}
