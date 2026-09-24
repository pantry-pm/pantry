/**
 * Version precedence, and what `latestVersion` should point at.
 *
 * `latestVersion` is what an unversioned `pantry install <pkg>` resolves to, so
 * every place that sets it has to agree on two things the old comparisons each
 * got wrong in their own way:
 *
 * - A prerelease is not always spelled with a dash. libgeos.org publishes
 *   `3.15.0beta1` and `3.15.0rc1`; splitting on `-` read both as 3.15.0, tied
 *   them with the real 3.15.0, and whichever landed first kept the pointer —
 *   so `latestVersion` sat on `3.15.0rc1` with 3.15.0 published beside it.
 * - "latest" means the newest STABLE release. A higher-numbered prerelease is
 *   newer, but it is not what someone who named no version asked for. Only a
 *   package that has never shipped a stable release falls back to a prerelease.
 */

/** Tags that mark a prerelease even without a `-` in front of them. */
const PRERELEASE_TAG = /^(?:alpha|beta|rc|dev|pre)/i

interface SplitVersion {
  numeric: number[]
  /** Everything after the numeric core, minus one leading separator. */
  tail: string
  prerelease: boolean
}

/**
 * `3.15.0rc1` → { numeric: [3,15,0], tail: 'rc1', prerelease: true }
 * `5.44.0-RC2` → { numeric: [5,44,0], tail: 'RC2', prerelease: true }
 * `1.1.1w` → { numeric: [1,1,1], tail: 'w', prerelease: false } (openssl's letter releases are stable)
 */
function splitVersion(version: string): SplitVersion {
  const v = version.startsWith('v') ? version.slice(1) : version
  const core = (/^[\d.]*/.exec(v)?.[0] || '').replace(/\.+$/, '')
  const rest = v.slice(core.length)
  const tail = rest.replace(/^[-+_.]/, '')
  return {
    numeric: core ? core.split('.').map(part => Number.parseInt(part, 10) || 0) : [0],
    tail,
    // `_beta` / `.rc1` count as tags too; `+build` metadata alone does not.
    prerelease: rest.startsWith('-') || PRERELEASE_TAG.test(tail),
  }
}

export function isPrereleaseVersion(version: string): boolean {
  return splitVersion(version).prerelease
}

/**
 * Order two versions: positive when `a` is newer.
 *
 * SemVer §11: at equal numerics a release outranks a prerelease; between two
 * prereleases the tags compare numerically, so RC2 beats RC1 and rc1 beats
 * beta3.
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a)
  const right = splitVersion(b)
  for (let i = 0; i < Math.max(left.numeric.length, right.numeric.length); i++) {
    const diff = (left.numeric[i] ?? 0) - (right.numeric[i] ?? 0)
    if (diff !== 0)
      return diff
  }
  if (left.prerelease !== right.prerelease)
    return left.prerelease ? -1 : 1
  return left.tail.localeCompare(right.tail, undefined, { numeric: true, sensitivity: 'base' })
}

export function newerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/** Newest first, by `compareVersions`. */
export function sortVersionsNewestFirst(versions: string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(b, a))
}

/**
 * Should `candidate` replace `current` as a package's `latestVersion`?
 *
 * For stores that only ever see the current pointer and the version being
 * published: a stable release always displaces a prerelease, a prerelease never
 * displaces a stable release, and otherwise the newer one wins.
 */
export function preferAsLatest(candidate: string, current: string | undefined | null): boolean {
  if (!current)
    return true
  const candidateIsPrerelease = isPrereleaseVersion(candidate)
  if (candidateIsPrerelease !== isPrereleaseVersion(current))
    return !candidateIsPrerelease
  return newerVersion(candidate, current)
}

/** The newest stable version, or the newest prerelease when there is no stable one. */
export function pickLatestVersion(versions: Iterable<string>): string | undefined {
  let best: string | undefined
  for (const version of versions) {
    if (preferAsLatest(version, best))
      best = version
  }
  return best
}

/**
 * A platform record that points at bytes someone actually uploaded.
 *
 * The pkgx fallback advertises versions it can materialize on demand as
 * `{ tarball, sha256: '', size: 0, uploadedAt: '' }`. Those are fine to offer
 * for an explicit version, but a stub is not a release: python.org's
 * `latestVersion` must not move to 3.14.7 while 3.14.7 is only a promise.
 */
export function isCompleteBinaryRecord(record: unknown): boolean {
  if (!record || typeof record !== 'object')
    return false
  const { sha256, size } = record as { sha256?: unknown, size?: unknown }
  return typeof sha256 === 'string' && sha256.length > 0
    && typeof size === 'number' && size > 0
}

/**
 * `latestVersion` for a binary package's metadata: the newest stable version
 * that has at least one complete upload, else the newest complete prerelease.
 * A manifest with no complete upload at all keeps the old rule over every key,
 * so it still resolves to something.
 */
export function latestPublishedVersion(
  versions: Record<string, { platforms?: Record<string, unknown> }> | undefined,
): string | undefined {
  const all = Object.keys(versions || {})
  const complete = all.filter(version =>
    Object.values(versions![version]?.platforms || {}).some(isCompleteBinaryRecord))
  return pickLatestVersion(complete.length > 0 ? complete : all)
}
