/**
 * Lightweight "does this concrete version satisfy this spec?" check for the
 * dependency operators accepted by Pantry's action.
 */
export function versionSatisfiesSpec(version: string, spec: string): boolean {
  if (!spec || spec === 'latest' || spec === '*')
    return true
  // Preserve prerelease/build identifiers for exact pins. Reducing both sides
  // to major.minor.patch would make every 0.17.0-dev.N snapshot appear equal.
  if (/^v?\d/.test(spec) && spec.includes('-'))
    return version.replace(/^v/, '') === spec.replace(/^v/, '')
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(n => Number.parseInt(n, 10) || 0)
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) {
      if ((a[i] ?? 0) !== (b[i] ?? 0))
        return (a[i] ?? 0) - (b[i] ?? 0)
    }
    return 0
  }
  const v = parse(version)
  const match = spec.match(/^([~^>=<]+)?(\d[\d.]*)/)
  if (!match) return false
  const op = match[1] || ''
  const t = parse(match[2])

  if (!op || op === '=' || op === '==') return cmp(v, t) === 0
  if (op === '>=') return cmp(v, t) >= 0
  if (op === '>') return cmp(v, t) > 0
  if (op === '<=') return cmp(v, t) <= 0
  if (op === '<') return cmp(v, t) < 0
  if (op === '~')
    return v[0] === t[0] && v[1] === t[1] && (v[2] ?? 0) >= (t[2] ?? 0)
  if (op === '^') {
    if (t[0] === 0 && t[1] === 0)
      return cmp(v, t) === 0
    if (t[0] === 0)
      return v[0] === 0 && v[1] === t[1] && (v[2] ?? 0) >= (t[2] ?? 0)
    return v[0] === t[0] && cmp(v, t) >= 0
  }
  return false
}

export function isRollingVersionSpec(domain: string, spec: string): boolean {
  return domain === 'ziglang.org' && spec.endsWith('-dev')
}

/**
 * Pantry lockfiles encode Zig build metadata with an underscore so the
 * version is safe to reuse as a filesystem segment. Restore the canonical
 * semver spelling before comparing it with, or passing it to, the installer.
 */
export function normalizeLockedVersion(domain: string, version: string): string {
  if (domain !== 'ziglang.org')
    return version
  return version.replace(/(-dev\.\d+)_([0-9A-Za-z-]+)$/, '$1+$2')
}

/**
 * Decide whether the action may reuse a concrete lock entry.
 *
 * A short Zig development version is a rolling channel, not an immutable
 * version. Zig removes older development archives, so pinning yesterday's
 * concrete channel result can turn an otherwise healthy setup into a 404.
 * Let the installer resolve this channel through download/index.json on every
 * cold setup; exact full development versions remain lockable.
 */
export function shouldUseLockedVersion(domain: string, pinned: string, spec: string): boolean {
  if (isRollingVersionSpec(domain, spec))
    return false
  return versionSatisfiesSpec(normalizeLockedVersion(domain, pinned), spec)
}

/**
 * Re-assert an already installed system package with its concrete resolution.
 * This keeps rolling channels fresh on the first install without resolving or
 * downloading the floating alias again after workspace installation.
 */
export function reassertVersionSpec(
  domain: string,
  declaredVersion: string,
  resolvedVersions: ReadonlyMap<string, string>,
): string {
  return resolvedVersions.get(domain) || declaredVersion
}
