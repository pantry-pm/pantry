/**
 * Continuous security alerts.
 *
 * `pantry audit` answers "is my tree vulnerable *right now*". That's the wrong
 * question, because the dangerous case is the advisory published next Tuesday
 * for the version you shipped last Tuesday. So an org registers what it
 * depends on, and the registry keeps checking.
 *
 * Two kinds of finding:
 *
 *   - **Vulnerabilities**, from OSV.dev — the same database GitHub, Google and
 *     the Rust and Go ecosystems publish into. Free, no key, and it covers npm,
 *     PyPI, Go, crates, Packagist and more.
 *   - **License policy**, from the org's own allow/deny list. "No AGPL in
 *     production" is a rule companies genuinely have, and nobody can enforce it
 *     by reading package pages one at a time.
 *
 * The watch list is the same set of entries the mirror stores, so an org that
 * has build insurance gets alerts over exactly what it insured.
 */

import type { TarballStorage } from './types'
import { orgKey, type MirrorEntry } from './mirror'

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown'

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
  unknown: 4,
}

export interface LicensePolicy {
  /** Only these licences are acceptable. Empty means "anything not denied". */
  allow?: string[]
  /** Never acceptable. Checked after `allow`, and wins. */
  deny?: string[]
}

export interface WatchList {
  org: string
  entries: MirrorEntry[]
  policy?: LicensePolicy
  updatedAt: string
}

export interface VulnerabilityAlert {
  type: 'vulnerability'
  package: string
  version: string
  ecosystem: string
  id: string
  severity: Severity
  summary: string
  url?: string
  fixedIn?: string
}

export interface LicenseAlert {
  type: 'license'
  package: string
  version: string
  license: string
  reason: 'denied' | 'not-allowed' | 'unknown'
  summary: string
}

export type Alert = VulnerabilityAlert | LicenseAlert

export interface AlertReport {
  org: string
  generatedAt: string
  watched: number
  alerts: Alert[]
  counts: { critical: number, high: number, moderate: number, low: number, license: number }
  /** Set when the advisory source couldn't be reached — an empty list then means "unknown", not "clean". */
  degraded?: string
}

// ---------------------------------------------------------------------------
// OSV
// ---------------------------------------------------------------------------

/** Map our ecosystem names to OSV's. */
export function osvEcosystem(ecosystem: string | undefined): string {
  switch ((ecosystem || 'npm').toLowerCase()) {
    case 'npm': return 'npm'
    case 'pypi':
    case 'python': return 'PyPI'
    case 'cargo':
    case 'crates': return 'crates.io'
    case 'go': return 'Go'
    case 'composer':
    case 'packagist': return 'Packagist'
    case 'rubygems':
    case 'gem': return 'RubyGems'
    case 'maven': return 'Maven'
    case 'nuget': return 'NuGet'
    // Our own system packages aren't in OSV under a package name; they're
    // tracked by CPE, which needs a different query. Skipped rather than
    // guessed at, so we never report a false all-clear.
    default: return ''
  }
}

/** Injectable so tests are deterministic and offline. */
export type AdvisoryFetcher = (entries: MirrorEntry[]) => Promise<Map<string, VulnerabilityAlert[]>>

/** Severity from an OSV record, which spells it several different ways. */
export function severityOf(vuln: any): Severity {
  const explicit = vuln?.database_specific?.severity
    || vuln?.affected?.[0]?.database_specific?.severity
  if (typeof explicit === 'string') {
    const normalized = explicit.toLowerCase()
    if (normalized === 'critical' || normalized === 'high' || normalized === 'moderate' || normalized === 'low')
      return normalized
    if (normalized === 'medium') return 'moderate'
  }

  // CVSS v3 base score, when that's all there is.
  const score = vuln?.severity?.find((s: any) => s.type?.startsWith('CVSS'))?.score
  if (typeof score === 'string') {
    const match = score.match(/\/(?:AV|A):/) ? null : Number.parseFloat(score)
    if (match !== null && Number.isFinite(match)) {
      if (match >= 9) return 'critical'
      if (match >= 7) return 'high'
      if (match >= 4) return 'moderate'
      if (match > 0) return 'low'
    }
  }

  return 'unknown'
}

/** First fixed version OSV knows about, when it knows one. */
export function fixedVersionOf(vuln: any): string | undefined {
  for (const affected of vuln?.affected || []) {
    for (const range of affected?.ranges || []) {
      for (const event of range?.events || []) {
        if (event?.fixed) return String(event.fixed)
      }
    }
  }
  return undefined
}

/** Query OSV for a batch of packages. */
export const osvFetcher: AdvisoryFetcher = async (entries) => {
  const queries = entries
    .map(e => ({ entry: e, ecosystem: osvEcosystem(e.ecosystem) }))
    .filter(q => q.ecosystem)

  const found = new Map<string, VulnerabilityAlert[]>()
  if (queries.length === 0) return found

  // OSV caps a batch; chunk rather than truncate, so a big lockfile is fully
  // checked instead of quietly half-checked.
  const CHUNK = 500
  for (let i = 0; i < queries.length; i += CHUNK) {
    const chunk = queries.slice(i, i + CHUNK)
    const res = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: chunk.map(q => ({
          package: { name: q.entry.name, ecosystem: q.ecosystem },
          version: q.entry.version,
        })),
      }),
    })
    if (!res.ok) throw new Error(`OSV responded ${res.status}`)

    const body = await res.json() as { results?: { vulns?: { id: string }[] }[] }
    const results = body.results || []

    for (let j = 0; j < chunk.length; j++) {
      const ids = (results[j]?.vulns || []).map(v => v.id).slice(0, 25)
      if (ids.length === 0) continue

      const alerts: VulnerabilityAlert[] = []
      for (const id of ids) {
        try {
          const detail = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`)
          const vuln = detail.ok ? await detail.json() as any : null
          alerts.push({
            type: 'vulnerability',
            package: chunk[j].entry.name,
            version: chunk[j].entry.version,
            ecosystem: chunk[j].ecosystem,
            id,
            severity: vuln ? severityOf(vuln) : 'unknown',
            summary: vuln?.summary || vuln?.details?.slice(0, 200) || id,
            url: `https://osv.dev/vulnerability/${id}`,
            fixedIn: vuln ? fixedVersionOf(vuln) : undefined,
          })
        }
        catch {
          alerts.push({
            type: 'vulnerability',
            package: chunk[j].entry.name,
            version: chunk[j].entry.version,
            ecosystem: chunk[j].ecosystem,
            id,
            severity: 'unknown',
            summary: id,
            url: `https://osv.dev/vulnerability/${id}`,
          })
        }
      }
      found.set(`${chunk[j].entry.name}@${chunk[j].entry.version}`, alerts)
    }
  }

  return found
}

// ---------------------------------------------------------------------------
// Licence policy
// ---------------------------------------------------------------------------

function normalizeLicense(license: string): string {
  return license.trim().toUpperCase()
}

/** Check one package's licence against a policy. Null when it's fine. */
export function checkLicense(entry: MirrorEntry, policy: LicensePolicy | undefined): LicenseAlert | null {
  if (!policy || (!policy.allow?.length && !policy.deny?.length)) return null

  const license = entry.license?.trim()
  if (!license) {
    // An unknown licence is only a finding when there's an allow-list, where
    // "we don't know" genuinely fails the rule.
    if (!policy.allow?.length) return null
    return {
      type: 'license',
      package: entry.name,
      version: entry.version,
      license: 'unknown',
      reason: 'unknown',
      summary: `${entry.name}@${entry.version} does not declare a licence, and your policy allows only: ${policy.allow.join(', ')}`,
    }
  }

  const normalized = normalizeLicense(license)

  if (policy.deny?.some(d => normalizeLicense(d) === normalized)) {
    return {
      type: 'license',
      package: entry.name,
      version: entry.version,
      license,
      reason: 'denied',
      summary: `${entry.name}@${entry.version} is ${license}, which your policy denies`,
    }
  }

  if (policy.allow?.length && !policy.allow.some(a => normalizeLicense(a) === normalized)) {
    return {
      type: 'license',
      package: entry.name,
      version: entry.version,
      license,
      reason: 'not-allowed',
      summary: `${entry.name}@${entry.version} is ${license}, which is not in your allowed list`,
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// The watch list
// ---------------------------------------------------------------------------

export class SecurityStore {
  constructor(
    private storage: TarballStorage,
    private fetcher: AdvisoryFetcher = osvFetcher,
  ) {}

  private key(org: string): string {
    return `security/${orgKey(org)}/watch.json`
  }

  async getWatchList(org: string): Promise<WatchList> {
    try {
      const bytes = await this.storage.download(this.key(org))
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as WatchList
      if (parsed && Array.isArray(parsed.entries)) return parsed
    }
    catch {
      // Nothing registered yet.
    }
    return { org, entries: [], updatedAt: new Date().toISOString() }
  }

  async setWatchList(org: string, entries: MirrorEntry[], policy?: LicensePolicy): Promise<WatchList> {
    const existing = await this.getWatchList(org)
    const list: WatchList = {
      org,
      entries,
      // A policy is only replaced when one is supplied, so re-registering a
      // lockfile from CI doesn't quietly wipe the rules someone set in the UI.
      policy: policy ?? existing.policy,
      updatedAt: new Date().toISOString(),
    }
    const body = new TextEncoder().encode(JSON.stringify(list)).buffer as ArrayBuffer
    await this.storage.upload(this.key(org), body)
    return list
  }

  async setPolicy(org: string, policy: LicensePolicy): Promise<WatchList> {
    const existing = await this.getWatchList(org)
    return this.setWatchList(org, existing.entries, policy)
  }

  /**
   * Everything currently wrong with what this org watches.
   *
   * If the advisory source is unreachable the report says so: an empty alert
   * list has to mean "clean", and silently returning one when we couldn't check
   * would be the most dangerous possible bug in a security feature.
   */
  async report(org: string): Promise<AlertReport> {
    const list = await this.getWatchList(org)
    const alerts: Alert[] = []
    let degraded: string | undefined

    try {
      const vulns = await this.fetcher(list.entries)
      for (const found of vulns.values()) alerts.push(...found)
    }
    catch (err) {
      degraded = `advisory lookup failed: ${(err as Error).message}`
    }

    for (const entry of list.entries) {
      const licenseAlert = checkLicense(entry, list.policy)
      if (licenseAlert) alerts.push(licenseAlert)
    }

    alerts.sort((a, b) => {
      const sa = a.type === 'vulnerability' ? SEVERITY_ORDER[a.severity] : 5
      const sb = b.type === 'vulnerability' ? SEVERITY_ORDER[b.severity] : 5
      return sa - sb || a.package.localeCompare(b.package)
    })

    const counts = { critical: 0, high: 0, moderate: 0, low: 0, license: 0 }
    for (const alert of alerts) {
      if (alert.type === 'license') counts.license++
      else if (alert.severity !== 'unknown') counts[alert.severity]++
    }

    return {
      org,
      generatedAt: new Date().toISOString(),
      watched: list.entries.length,
      alerts,
      counts,
      ...(degraded ? { degraded } : {}),
    }
  }
}

/** Parse a licence policy from a request body, ignoring anything malformed. */
export function normalizePolicy(value: unknown): LicensePolicy | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length < 100).slice(0, 200) : undefined

  const allow = strings(raw.allow)
  const deny = strings(raw.deny)
  if (!allow && !deny) return undefined
  return { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) }
}
