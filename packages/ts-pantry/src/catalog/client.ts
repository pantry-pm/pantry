import snapshot from '../../../../catalog/packages.json'
import type { PackageCatalogEntry, PackageKind } from './types'
export type { PackageCatalogEntry, PackageKind, PackageLogo } from './types'

export const bundledPackageCatalogRevision: string = snapshot.revision
export const packageCatalogUrl = 'https://raw.githubusercontent.com/pantry-pm/pantry/main/catalog/packages.json'
const kinds = new Set<PackageKind>(['app', 'cli', 'library', 'font'])

/** Validate external discovery data before a UI can offer it as an install target. */
export function parsePackageCatalog(value: unknown): PackageCatalogEntry[] {
  if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== 1 || !Array.isArray((value as { packages?: unknown }).packages))
    throw new Error('Unsupported Pantry catalog format')
  const entries = (value as { packages: unknown[] }).packages
  if (entries.length > 50000) throw new Error('Pantry catalog exceeds its entry limit')
  const seen = new Set<string>()
  return entries.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid Pantry catalog entry')
    const entry = raw as PackageCatalogEntry
    if (typeof entry.domain !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,213}$/.test(entry.domain) || entry.domain.split('/').some(part => !part || part === '.' || part === '..') || seen.has(entry.domain))
      throw new Error('Invalid or duplicate Pantry package identifier')
    seen.add(entry.domain)
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 256 || typeof entry.description !== 'string' || entry.description.length > 10000 || !kinds.has(entry.kind))
      throw new Error('Invalid Pantry package metadata')
    for (const values of [entry.aliases, entry.programs]) {
      if (!Array.isArray(values) || values.length > 1000 || values.some(value => typeof value !== 'string' || value.length > 256)) throw new Error('Invalid Pantry package aliases or programs')
    }
    if (entry.platforms !== null && (!Array.isArray(entry.platforms) || entry.platforms.some(value => typeof value !== 'string' || value.length > 64))) throw new Error('Invalid Pantry platform metadata')
    for (const [url, artwork] of [[entry.homepageUrl, false], [entry.githubUrl, false], [entry.logo?.url, true], [entry.logo?.sourceUrl, true]] as const) {
      if (url !== null && url !== undefined) {
        if (typeof url !== 'string') throw new Error('Invalid Pantry URL')
        const parsed = new URL(url)
        if (!(artwork ? parsed.protocol === 'https:' : ['https:', 'http:'].includes(parsed.protocol)) || parsed.username || parsed.password) throw new Error('Pantry metadata requires web URLs and HTTPS artwork')
      }
    }
    if (entry.logo && !/^[a-f0-9]{64}$/.test(entry.logo.sha256)) throw new Error('Invalid Pantry logo identity')
    if (entry.latestVersion !== null && (typeof entry.latestVersion !== 'string' || entry.latestVersion.length > 128)) throw new Error('Invalid Pantry version')
    return entry
  })
}

/** Catalog queries are local. A refresh downloads one public metadata snapshot. */
export async function fetchPackageCatalog(options: { signal?: AbortSignal, fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response> } = {}): Promise<PackageCatalogEntry[]> {
  const response = await (options.fetch ?? globalThis.fetch)(packageCatalogUrl, { signal: options.signal ?? AbortSignal.timeout(20000), headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Could not refresh Pantry catalog (${response.status})`)
  const text = await response.text()
  if (text.length > 16000000) throw new Error('Pantry catalog exceeds its download limit')
  return parsePackageCatalog(JSON.parse(text))
}

export function searchPackageCatalog(entries: readonly PackageCatalogEntry[], query: string, options: { kind?: PackageKind, limit?: number } = {}): PackageCatalogEntry[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  const requested = Number.isFinite(options.limit ?? 100) ? Math.floor(options.limit ?? 100) : 100
  const limit = Math.min(50000, Math.max(1, requested))
  return entries.filter(entry => (!options.kind || entry.kind === options.kind) && words.every(word => [entry.name, entry.domain, ...entry.aliases, ...entry.programs, entry.description].some(value => value.toLocaleLowerCase().includes(word))))
    .sort((a, b) => {
      const exactA = [a.name, a.domain, ...a.aliases, ...a.programs].some(value => value.toLocaleLowerCase() === query.toLocaleLowerCase().trim())
      const exactB = [b.name, b.domain, ...b.aliases, ...b.programs].some(value => value.toLocaleLowerCase() === query.toLocaleLowerCase().trim())
      return Number(exactB) - Number(exactA) || a.name.localeCompare(b.name)
    }).slice(0, limit)
}

/** Prepare an immutable catalog snapshot once for interactive search. Recreate after a refresh. */
export function createPackageCatalogSearch(entries: readonly PackageCatalogEntry[]) {
  const index = entries.map(entry => ({
    entry,
    names: [entry.name, entry.domain, ...entry.aliases, ...entry.programs].map(value => value.toLocaleLowerCase()),
    description: entry.description.toLocaleLowerCase(),
  })).sort((a, b) => a.entry.name.localeCompare(b.entry.name))
  return (query: string, options: { kind?: PackageKind, limit?: number } = {}): PackageCatalogEntry[] => {
    const term = query.toLocaleLowerCase().trim()
    const words = term.split(/\s+/).filter(Boolean)
    const requested = Number.isFinite(options.limit ?? 100) ? Math.floor(options.limit ?? 100) : 100
    const limit = Math.min(50000, Math.max(1, requested))
    const exact: PackageCatalogEntry[] = []
    const matches: PackageCatalogEntry[] = []
    for (const item of index) {
      if (options.kind && item.entry.kind !== options.kind) continue
      if (!words.every(word => item.description.includes(word) || item.names.some(name => name.includes(word)))) continue
      if (item.names.includes(term)) exact.push(item.entry)
      else if (matches.length < limit) matches.push(item.entry)
    }
    return exact.concat(matches).slice(0, limit)
  }
}

/** Complete offline metadata snapshot. No installer implementation is imported. */
export function bundledPackageCatalog(): PackageCatalogEntry[] {
  return parsePackageCatalog(snapshot)
}
