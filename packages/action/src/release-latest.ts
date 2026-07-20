export type GitHubMakeLatest = 'true' | 'false' | 'legacy'
export type ReleaseMakeLatestInput = 'auto' | GitHubMakeLatest

interface ParsedSemver {
  major: number
  minor: number
  patch: number
}

export function normalizeReleaseMakeLatest(value: string): ReleaseMakeLatestInput {
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized === 'auto')
    return 'auto'
  if (normalized === 'true' || normalized === 'false' || normalized === 'legacy')
    return normalized

  throw new Error('release-make-latest must be one of: auto, true, false, legacy')
}

export function resolveSemanticMakeLatest(
  tag: string,
  repositoryTags: string[],
  mode: ReleaseMakeLatestInput,
  prerelease = false,
): GitHubMakeLatest {
  if (mode !== 'auto')
    return mode
  if (prerelease)
    return 'false'

  const target = parseStableSemver(tag)
  if (!target)
    return 'legacy'

  const stableTags = [...repositoryTags, tag]
    .map(candidate => ({ tag: candidate, version: parseStableSemver(candidate) }))
    .filter((candidate): candidate is { tag: string, version: ParsedSemver } => candidate.version !== undefined)

  const newest = stableTags.sort((a, b) => compareSemver(b.version, a.version))[0]
  return newest?.tag === tag ? 'true' : 'false'
}

function parseStableSemver(tag: string): ParsedSemver | undefined {
  const match = tag.match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (!match)
    return undefined

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}
