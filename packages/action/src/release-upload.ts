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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined
}

function isRetryableUploadError(error: unknown): boolean {
  const status = errorStatus(error)
  if (status !== undefined && (status === 408 || status === 409 || status === 422 || status === 429 || status >= 500))
    return true

  return /already exists|already_exists|bad gateway|creating policy|updating policy|rate limit|timed? ?out|temporar/i.test(errorMessage(error))
}

export async function uploadReleaseAssetReliably(options: ReliableReleaseUploadOptions): Promise<ReliableReleaseUploadResult> {
  const maxAttempts = options.maxAttempts ?? 4
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

      if (!isRetryableUploadError(error) || attempt === maxAttempts)
        throw error

      const delay = retryDelayMs * 2 ** (attempt - 1)
      options.onRetry?.(`Upload of ${options.name} failed (${errorMessage(error)}); retrying in ${delay}ms`)
      await sleep(delay)
    }
  }

  throw lastError
}
