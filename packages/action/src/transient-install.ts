/**
 * `pantry install` already retries a timed-out download once, ten seconds
 * later. A registry that is slow for longer than that (a large archive such as
 * ffmpeg on a cold mirror) still fails the whole job, although Pantry marks the
 * failure as transient. The action reruns such an install: `pantry install`
 * skips what is already on disk, so a rerun fetches only what failed.
 *
 * Failures that are not marked transient (a missing version, a solver
 * conflict) are returned at once: rerunning them only spends minutes.
 */

export interface ExecListeners {
  stdout?: (data: Buffer) => void
  stderr?: (data: Buffer) => void
}

export interface TransientInstallOptions {
  /** Total runs, including the first. */
  attempts?: number
  /** Wait before rerun n (1-based); the last value repeats. */
  delaysMs?: number[]
  onRetry?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
}

/** Pantry's own markers: `(transient)` on the summary line, `[transient: ...]` on the error. */
const TRANSIENT_MARKER = /\(transient\)|\[transient:/i
const PACKAGE_RETRY_AFTER = /^::error title=pantry install failed::[^\n]* registry answered HTTP \d+ \(Retry-After (\d+)s\)/gm
const LEGACY_RATE_LIMIT = /^::error title=pantry install failed::[^\n]* registry answered HTTP 429\b/m
const LEGACY_LONG_COOLDOWN = /Registry GET HTTP 429[^\n]*; Retry-After exceeds request budget/

export function isTransientPantryFailure(output: string): boolean {
  return TRANSIENT_MARKER.test(output)
}

/**
 * Run `install` until it exits 0, it fails without a transient marker, or the
 * attempts are spent. `install` must not throw on a non-zero exit
 * (`ignoreReturnCode: true`) and must feed its output to the listeners.
 */
export async function runRetryingTransientInstall(
  description: string,
  install: (listeners: ExecListeners) => Promise<number>,
  options: TransientInstallOptions = {},
): Promise<number> {
  const attempts = Math.max(1, options.attempts ?? 3)
  const delays = options.delaysMs?.length ? options.delaysMs : [30_000, 60_000]
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))

  let code = 1
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let output = ''
    const collect = (data: Buffer): void => {
      output += data.toString()
    }
    code = await install({ stdout: collect, stderr: collect })
    if (code === 0 || attempt === attempts || !isTransientPantryFailure(output))
      return code

    const retryAfterSeconds = Array.from(output.matchAll(PACKAGE_RETRY_AFTER))
      .reduce((latest, response) => Math.max(latest, Number(response[1])), 0)
    const maxDelay = Math.max(...delays)
    if (retryAfterSeconds * 1000 > maxDelay || (LEGACY_RATE_LIMIT.test(output) && LEGACY_LONG_COOLDOWN.test(output))) {
      const cooldown = retryAfterSeconds ? `Retry-After ${retryAfterSeconds}s` : 'Retry-After exceeds the download budget'
      options.onRetry?.(`${description} stopped after the registry cooldown exceeded the action retry budget (${cooldown})`)
      return code
    }

    const delay = Math.max(delays[Math.min(attempt - 1, delays.length - 1)]!, retryAfterSeconds * 1000)
    options.onRetry?.(
      `${description} failed with a transient error (attempt ${attempt} of ${attempts}); `
      + `running it again in ${Math.round(delay / 1000)}s`,
    )
    await sleep(delay)
  }
  return code
}
