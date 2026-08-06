/**
 * Per-client ceiling on binary artifact downloads.
 *
 * /binaries/ had no limit of any kind: one client in a retry loop, or one
 * scraper walking the catalog, could pull the whole registry as fast as the
 * bucket would serve it, and the first we would hear of it is the provider's
 * "included traffic exceeded" mail. Requests alone are the wrong unit — a
 * thousand checksum fetches cost nothing while ten desktop bundles cost
 * gigabytes — so the limiter budgets both request count and bytes, and the byte
 * budget is the one that maps to the bill.
 *
 * Defaults are deliberately far above any real install (a full `pantry install`
 * is tens of artifacts) so this only ever catches a runaway, and both budgets
 * are tunable — set either to 0 to disable that dimension.
 */

export interface RateLimitDecision {
  allowed: boolean
  /** Seconds until the client's window resets. Zero when allowed. */
  retryAfterSeconds: number
  limit?: 'requests' | 'bytes'
}

export interface BinaryRateLimitOptions {
  maxRequests?: number
  maxBytes?: number
  windowMs?: number
  maxClients?: number
  now?: () => number
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000
const DEFAULT_MAX_REQUESTS = 600
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024 * 1024
/** Bound on tracked clients so the limiter cannot itself become the leak. */
const DEFAULT_MAX_CLIENTS = 20_000

interface ClientWindow {
  windowStart: number
  requests: number
  bytes: number
}

export class BinaryDownloadRateLimiter {
  private readonly clients = new Map<string, ClientWindow>()
  private readonly maxRequests: number
  private readonly maxBytes: number
  private readonly windowMs: number
  private readonly maxClients: number
  private readonly now: () => number

  constructor(options: BinaryRateLimitOptions = {}) {
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS
    this.now = options.now ?? Date.now
  }

  get enabled(): boolean {
    return this.maxRequests > 0 || this.maxBytes > 0
  }

  /**
   * Charge one download to a client and say whether it may proceed.
   *
   * A rejected request is not charged — otherwise a client held over the line
   * by its own retries could never fall back under it.
   */
  check(clientKey: string, bytes: number): RateLimitDecision {
    if (!this.enabled)
      return { allowed: true, retryAfterSeconds: 0 }

    const now = this.now()
    let window = this.clients.get(clientKey)
    if (!window || now - window.windowStart >= this.windowMs) {
      window = { windowStart: now, requests: 0, bytes: 0 }
      this.clients.set(clientKey, window)
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((window.windowStart + this.windowMs - now) / 1000))
    if (this.maxRequests > 0 && window.requests + 1 > this.maxRequests)
      return { allowed: false, retryAfterSeconds, limit: 'requests' }
    if (this.maxBytes > 0 && window.bytes + Math.max(0, bytes) > this.maxBytes)
      return { allowed: false, retryAfterSeconds, limit: 'bytes' }

    window.requests++
    window.bytes += Math.max(0, bytes)
    this.prune(now)
    return { allowed: true, retryAfterSeconds: 0 }
  }

  /** Drop expired windows, then the oldest entries if we are still over budget. */
  private prune(now: number): void {
    if (this.clients.size <= this.maxClients)
      return
    for (const [key, window] of this.clients) {
      if (now - window.windowStart >= this.windowMs)
        this.clients.delete(key)
    }
    // Map iteration is insertion-ordered, so this sheds the least recently
    // started windows first.
    for (const key of this.clients.keys()) {
      if (this.clients.size <= this.maxClients)
        break
      this.clients.delete(key)
    }
  }
}

/**
 * Identify the caller for rate-limiting purposes.
 *
 * The registry sits behind a reverse proxy, so the socket address is always the
 * proxy and the client has to be read from a header. Which header, and which
 * part of it, decides whether the limit can be evaded outright.
 *
 * `X-Forwarded-For` is a list that each proxy *appends* to, and the client
 * controls whatever was in it on arrival. Reading the leftmost entry — the
 * conventional-looking choice — therefore reads a value the client wrote, so
 * anyone can rotate it and never hit a limit. The rightmost entry is the one
 * the nearest proxy added and is the only part of that header we can trust.
 *
 * `CF-Connecting-IP` is better still: Cloudflare sets it to the real client and
 * strips any client-supplied copy, so it is preferred when present. Behind
 * additional trusted hops, set `PANTRY_TRUSTED_PROXY_HOPS` to count further
 * left in the list.
 */
export function rateLimitClientKey(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  const cloudflare = req.headers.get('cf-connecting-ip')?.trim()
  if (cloudflare)
    return cloudflare

  // Set by nginx/rpx with `proxy_set_header`, which overwrites rather than
  // appends, so it cannot carry a client-supplied value.
  const real = req.headers.get('x-real-ip')?.trim()
  if (real)
    return real

  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const hops = Number.parseInt(env.PANTRY_TRUSTED_PROXY_HOPS || '1', 10)
    const trusted = Number.isFinite(hops) && hops >= 1 ? hops : 1
    const entries = forwarded.split(',').map(entry => entry.trim()).filter(Boolean)
    // Count in from the right: one trusted hop ⇒ the last entry, which that hop
    // appended itself. Never fall past the start into client-written territory.
    const candidate = entries[entries.length - trusted]
    if (candidate)
      return candidate
  }
  return 'unknown'
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined)
    return fallback
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function binaryRateLimiterFromEnv(env: NodeJS.ProcessEnv = process.env): BinaryDownloadRateLimiter {
  return new BinaryDownloadRateLimiter({
    maxRequests: positiveNumber(env.PANTRY_BINARY_RATE_LIMIT_REQUESTS_PER_HOUR, DEFAULT_MAX_REQUESTS),
    maxBytes: positiveNumber(env.PANTRY_BINARY_RATE_LIMIT_GIB_PER_HOUR, DEFAULT_MAX_BYTES / 1024 ** 3) * 1024 ** 3,
  })
}
