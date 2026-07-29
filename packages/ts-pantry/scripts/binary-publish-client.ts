import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'

export interface PublishBinaryArtifactOptions {
  domain: string
  version: string
  platforms: string[]
  filePath: string
  filename: string
  size: number
  registryUrl?: string
  token?: string
}

export interface PublishedBinaryArtifact {
  success: true
  domain: string
  version: string
  platforms: Record<string, {
    tarball: string
    sha256: string
    size: number
    uploadedAt: string
  }>
  scan: {
    verdict: string
    engine: string
    artifactSha256: string
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('end', resolve)
    stream.once('error', reject)
  })
  return hash.digest('hex')
}

async function responseJson(response: Response): Promise<any> {
  return response.json().catch(async () => ({
    error: await response.text().catch(() => response.statusText),
  }))
}

function registryConfig(options: PublishBinaryArtifactOptions): { registryUrl: string, token: string } {
  const registryUrl = (
    options.registryUrl
    || process.env.PANTRY_REGISTRY_URL
    || process.env.REGISTRY_URL
    || 'https://registry.pantry.dev'
  ).replace(/\/+$/, '')
  const token = options.token || process.env.PANTRY_REGISTRY_TOKEN || process.env.PANTRY_TOKEN || ''
  if (!token)
    throw new Error('PANTRY_REGISTRY_TOKEN or PANTRY_TOKEN is required for binary publication')
  return { registryUrl, token }
}

/**
 * Publish one native artifact through the registry's scan-before-promote API.
 *
 * The file is streamed directly to an untrusted presigned staging key. Only the
 * registry can promote it into binaries/, and only after a clean verdict for
 * the exact expected SHA-256 and byte length.
 */
export async function publishBinaryArtifact(
  options: PublishBinaryArtifactOptions,
): Promise<PublishedBinaryArtifact> {
  const { registryUrl, token } = registryConfig(options)
  const sha256 = await sha256File(options.filePath)
  const auth = { Authorization: `Bearer ${token}` }

  const initiateResponse = await fetch(`${registryUrl}/api/v1/binaries/uploads`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      domain: options.domain,
      version: options.version,
      platforms: options.platforms,
      filename: options.filename,
      size: options.size,
      sha256,
    }),
  })
  const initiated = await responseJson(initiateResponse)
  if (!initiateResponse.ok || !initiated.uploadId || !initiated.uploadUrl) {
    throw new Error(`${initiated.code || initiateResponse.status}: ${initiated.error || initiateResponse.statusText}`)
  }

  const uploadArgs = [
    '-fsS',
    '--connect-timeout', '30',
    '--speed-limit', '1024',
    '--speed-time', '120',
    '--retry', '3',
    '--retry-all-errors',
    '-X', 'PUT',
  ]
  for (const [name, value] of Object.entries(initiated.uploadHeaders || {}))
    uploadArgs.push('-H', `${name}: ${value}`)
  uploadArgs.push('-T', options.filePath, initiated.uploadUrl)
  execFileSync('curl', uploadArgs, { stdio: ['ignore', 'ignore', 'inherit'] })

  const completeResponse = await fetch(`${registryUrl}/api/v1/binaries/uploads/complete`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: initiated.uploadId }),
  })
  const completed = await responseJson(completeResponse)
  if (!completeResponse.ok || completed.success !== true) {
    const retryable = completed.retryable ? ' (retryable)' : ''
    throw new Error(`${completed.code || completeResponse.status}: ${completed.error || completeResponse.statusText}${retryable}`)
  }
  if (completed.scan?.artifactSha256 !== sha256 || completed.scan?.verdict !== 'clean')
    throw new Error('Registry returned an invalid binary malware-scan attestation')
  return completed as PublishedBinaryArtifact
}
