export interface ReleaseAsset {
  id: number
  name: string
  size: number
  state?: string
}

export interface ReliableReleaseUploadOptions {
  name: string
  size: number
  upload: () => Promise<void>
  listAssets: () => Promise<ReleaseAsset[]>
  deleteAsset: (assetId: number) => Promise<void>
  onRetry?: (message: string) => void
  sleep?: (milliseconds: number) => Promise<void>
  maxAttempts?: number
  retryDelayMs?: number
}

export type ReliableReleaseUploadResult = 'uploaded' | 'already-present' | 'reconciled'

// GitHub release endpoints can remain unavailable long after the rest of
// Actions recovers. At the 30-second backoff cap this keeps retrying for almost
// two hours, while permanent 4xx failures still fail immediately.
export const DEFAULT_GITHUB_RELEASE_MAX_ATTEMPTS = 240

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined
}

export function isRetryableGitHubReleaseError(error: unknown): boolean {
  const status = errorStatus(error)
  if (status !== undefined && (status === 408 || status === 409 || status === 422 || status === 429 || status >= 500))
    return true

  return /already exists|already_exists|bad gateway|creating policy|updating policy|rate limit|timed? ?out|temporar/i.test(errorMessage(error))
}

export interface GitHubReleaseRetryOptions {
  maxAttempts?: number
  retryDelayMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  onRetry?: (message: string) => void
}

export async function retryGitHubReleaseOperation<T>(
  label: string,
  operation: () => Promise<T>,
  options: GitHubReleaseRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_GITHUB_RELEASE_MAX_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? 2000
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation()
    }
    catch (error) {
      lastError = error
      if (!isRetryableGitHubReleaseError(error) || attempt === maxAttempts)
        throw error

      const delay = Math.min(retryDelayMs * 2 ** (attempt - 1), 30000)
      options.onRetry?.(`${label} failed (${errorMessage(error)}); retrying in ${delay}ms`)
      await sleep(delay)
    }
  }

  throw lastError
}

export async function uploadReleaseAssetReliably(options: ReliableReleaseUploadOptions): Promise<ReliableReleaseUploadResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_GITHUB_RELEASE_MAX_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? 2000
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await options.upload()
      return 'uploaded'
    }
    catch (error) {
      lastError = error

      // GitHub can finish storing an asset and still return a transient policy
      // error. Reconcile against the release before retrying so a successful
      // upload is never reported as a failed release.
      const assets = await options.listAssets().catch(() => [] as ReleaseAsset[])
      const existing = assets.find(asset => asset.name === options.name)
      if (existing?.state === 'uploaded' && existing.size === options.size)
        return attempt === 1 ? 'reconciled' : 'already-present'

      if (existing) {
        await options.deleteAsset(existing.id).catch(() => undefined)
      }

      if (!isRetryableGitHubReleaseError(error) || attempt === maxAttempts)
        throw error

      const delay = Math.min(retryDelayMs * 2 ** (attempt - 1), 30000)
      options.onRetry?.(`Upload of ${options.name} failed (${errorMessage(error)}); retrying in ${delay}ms`)
      await sleep(delay)
    }
  }

  throw lastError
}
