export interface ReleaseDownloadRetryOptions {
  maxAttempts?: number
  retryDelayMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  onRetry?: (message: string) => void
}

const DEFAULT_RELEASE_DOWNLOAD_MAX_ATTEMPTS = 40

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = Number((error as { status?: unknown }).status)
    if (Number.isFinite(status)) return status
  }

  const match = errorMessage(error).match(/(?:HTTP response|status(?: code)?)[^0-9]*(\d{3})/i)
  return match ? Number(match[1]) : undefined
}

export function isRetryableReleaseDownloadError(error: unknown): boolean {
  const status = errorStatus(error)
  if (status !== undefined)
    return status === 404 || status === 408 || status === 429 || status >= 500

  return /not found|rate limit|timed? ?out|temporar|service unavailable/i.test(errorMessage(error))
}

export async function downloadReleaseAssetReliably(
  label: string,
  download: () => Promise<string>,
  options: ReleaseDownloadRetryOptions = {},
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_RELEASE_DOWNLOAD_MAX_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? 2000
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await download()
    }
    catch (error) {
      lastError = error
      if (!isRetryableReleaseDownloadError(error)) throw error
      if (attempt === maxAttempts) break

      const delay = Math.min(retryDelayMs * 2 ** (attempt - 1), 30000)
      options.onRetry?.(`${label} is not available yet (${errorMessage(error)}); retrying in ${delay}ms`)
      await sleep(delay)
    }
  }

  throw new Error(`${label} remained unavailable after ${maxAttempts} attempts: ${errorMessage(lastError)}`)
}
