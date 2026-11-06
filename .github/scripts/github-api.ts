interface GitHubApiOptions {
  token: string
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Bound transient read/status retries by the caller deadline; dispatches reconcile separately. */
export function createGitHubApi(options: GitHubApiOptions): (path: string, init?: RequestInit, budgetMs?: number) => Promise<any> {
  const request = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? Bun.sleep
  return async (path, init = {}, budgetMs = 30_000) => {
    const deadline = now() + budgetMs
    const retryable = !init.method || init.method === 'GET' || /\/statuses\//.test(path)
    for (let attempt = 0; attempt < 4; attempt++) {
      const remaining = deadline - now()
      if (remaining <= 0) throw new Error('GitHub API request exceeded its wait budget')
      let response: Response
      let body: string
      try {
        response = await request(`https://api.github.com/${path}`, {
          ...init, headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(Math.ceil(remaining)),
        })
        body = await response.text()
      }
      catch {
        if (!retryable || attempt === 3) throw new Error('GitHub API network request failed after bounded retries')
        const delay = 1000 * 2 ** attempt
        if (delay >= deadline - now()) throw new Error('GitHub API request exceeded its wait budget')
        await sleep(delay)
        continue
      }
      if (now() >= deadline) throw new Error('GitHub API request exceeded its wait budget')
      if (response.ok) return body ? JSON.parse(body) : null
      const limited = response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0'
        || response.headers.has('retry-after') || /rate limit/i.test(body))
      const transient = limited || response.status === 408 || response.status === 429 || response.status >= 500
      if (!retryable || !transient || attempt === 3) throw new Error(`GitHub API HTTP ${response.status}`)
      const retryAfter = response.headers.get('retry-after')
      const delay = Math.max(1000 * 2 ** attempt, retryAfter
        ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now()) || 0
        : limited ? Number(response.headers.get('x-ratelimit-reset') || 0) * 1000 - now() : 0)
      if (delay >= deadline - now()) throw new Error('GitHub API retry would exceed its wait budget')
      await sleep(delay)
    }
    throw new Error('GitHub API retry limit exceeded')
  }
}
