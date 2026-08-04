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

export interface CompleteBinaryUploadOptions {
  /**
   * Give up after this long, regardless of attempts remaining. Bounds the
   * wait by the thing that actually varies - how long the registry takes to
   * scan the artifact - rather than by a fixed number of polls.
   */
  deadlineMs?: number
  attempts?: number
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  sleep?: (milliseconds: number) => Promise<void>
}

class PermanentCompletionError extends Error {}

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

function completionError(response: Response, completed: any): Error {
  const retryable = completed.retryable ? ' (retryable)' : ''
  return new Error(`${completed.code || response.status}: ${completed.error || response.statusText}${retryable}`)
}

function completionMayStillBeRunning(response: Response, completed: any): boolean {
  return (
    response.status === 408
    || response.status === 425
    || response.status === 429
    || (response.status >= 500 && !completed.code)
    || (response.status === 404 && completed.code === 'BINARY_STAGING_NOT_FOUND')
  )
}

/**
 * Complete an upload through the Registry's idempotent endpoint.
 *
 * A proxy or client socket can disappear after Registry has sealed and scanned
 * the artifact but before the success response reaches the publisher. Retrying
 * the signed upload claim is safe: Registry returns the exact completed,
 * digest-bound metadata once promotion commits. A missing staging object is
 * therefore temporarily ambiguous while the first request is still scanning.
 */
export async function completeBinaryUpload(
  registryUrl: string,
  uploadId: string,
  auth: { Authorization: string },
  options: CompleteBinaryUploadOptions = {},
): Promise<any> {
  // 15 attempts with the backoff below is a budget of roughly five minutes,
  // which is not enough time for the registry to scan a large artifact: a
  // 273MB package left every retry returning BINARY_STAGING_NOT_FOUND and the
  // publish gave up while the first request was still scanning, discarding a
  // build that had in fact succeeded.
  //
  // The wait is bounded by TIME rather than attempt count, because what
  // matters is how long the scan takes, not how many times we asked.
  const attempts = Math.max(1, options.attempts ?? 60)
  const deadline = Date.now() + (options.deadlineMs ?? 30 * 60_000)
  const fetchUpload = options.fetch ?? fetch
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  let lastError: Error = new Error('binary upload completion did not run')

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchUpload(`${registryUrl}/api/v1/binaries/uploads/complete`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId }),
      })
      const completed = await responseJson(response)
      if (response.ok && completed.success === true)
        return completed

      lastError = completionError(response, completed)
      if (!completionMayStillBeRunning(response, completed))
        throw new PermanentCompletionError(lastError.message)
    }
    catch (error) {
      if (error instanceof PermanentCompletionError)
        throw error
      lastError = error instanceof Error ? error : new Error(String(error))
    }

    if (attempt >= attempts || Date.now() >= deadline)
      break
    await sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)))
  }

  throw new Error(`Binary upload completion remained ambiguous after ${attempts} attempts: ${lastError.message}`)
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

  const completed = await completeBinaryUpload(registryUrl, initiated.uploadId, auth)
  if (completed.scan?.artifactSha256 !== sha256 || completed.scan?.verdict !== 'clean')
    throw new Error('Registry returned an invalid binary malware-scan attestation')
  return completed as PublishedBinaryArtifact
}
