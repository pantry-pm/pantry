export const claudeReleaseFeed = 'https://downloads.claude.ai/releases/darwin/universal/RELEASES.json'
export interface ClaudeRelease { version: string, url: string }
const versionPattern = /^\d+(?:\.\d+){1,3}$/

/** Use Anthropic's own updater feed; never substitute a different version or host. */
export function parseClaudeReleases(data: unknown): ClaudeRelease[] {
  const feed = data as { currentRelease?: unknown, releases?: unknown }
  if (!feed || typeof feed.currentRelease !== 'string' || !versionPattern.test(feed.currentRelease) || !Array.isArray(feed.releases)) throw new Error('Invalid Claude desktop release feed')
  const releases = new Map<string, ClaudeRelease>()
  for (const item of feed.releases) {
    const release = item as { version?: unknown, updateTo?: { version?: unknown, url?: unknown } }
    const version = release?.version
    const update = release?.updateTo
    if (typeof version !== 'string' || !versionPattern.test(version) || update?.version !== version || typeof update.url !== 'string') throw new Error('Invalid Claude desktop release')
    const match = update.url.match(/^https:\/\/downloads\.claude\.ai\/releases\/darwin\/universal\/(\d+(?:\.\d+){1,3})\/Claude-[a-f0-9]{40}\.zip$/)
    if (!match || match[1] !== version) throw new Error('Claude release must use its exact official versioned archive')
    if (releases.has(version) && releases.get(version)!.url !== update.url) throw new Error('Conflicting Claude desktop archives')
    releases.set(version, { version, url: update.url })
  }
  const current = releases.get(feed.currentRelease)
  if (!current) throw new Error('Current Claude desktop release is missing')
  return [current, ...[...releases.values()].filter(item => item.version !== current.version)]
}

export async function fetchClaudeReleases(fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<ClaudeRelease[]> {
  const response = await fetcher(claudeReleaseFeed, { signal: AbortSignal.timeout(15000), redirect: 'error' })
  if (!response.ok) throw new Error(`Claude release feed returned HTTP ${response.status}`)
  return parseClaudeReleases(await response.json())
}

if (import.meta.main) {
  const version = process.argv[2]
  const release = (await fetchClaudeReleases()).find(item => item.version === version)
  if (!release) throw new Error(`Claude ${version} is not available in the official release feed; refusing to download another version`)
  process.stdout.write(release.url)
}
