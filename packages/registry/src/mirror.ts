/**
 * Build insurance — a private mirror of everything an org installs.
 *
 * The failure this exists to prevent: a dependency you rely on is unpublished,
 * retagged, or deleted, and a build that worked yesterday can't be reproduced
 * today. It has happened to npm, to Go modules, to container registries, and it
 * will happen again.
 *
 * So: a paid org tells the registry what it installed, and the registry keeps a
 * copy of each artifact in that org's own namespace. When upstream is gone, the
 * mirror still serves the exact bytes — matched by integrity hash, not by name,
 * so a *retagged* version is caught too rather than silently mirrored over.
 *
 * Two shapes of storage, both on the object store the registry already uses:
 *
 *   mirror/<org>/index.json                  what this org has snapshotted
 *   mirror/<org>/<name>/<version>/<hash>.tgz the bytes
 *
 * Keying artifacts by content hash means the same tarball pulled by ten orgs is
 * still ten copies — deliberately. A private mirror that dedupes across
 * tenants isn't a private mirror, and it would let one org's deletion affect
 * another's builds.
 */

import type { TarballStorage } from './types'

/** One artifact an org installed. */
export interface MirrorEntry {
  name: string
  version: string
  /** Where it came from. Used to fetch it the first time, and for provenance. */
  resolved?: string
  /** Subresource-integrity string, e.g. `sha256-…` or `sha512-…`. */
  integrity?: string
  /** npm, pantry, github… — recorded so an SBOM can name the ecosystem. */
  ecosystem?: string
  license?: string
}

/** What the mirror knows about one stored artifact. */
export interface MirrorRecord extends MirrorEntry {
  /** Object key of the stored bytes. Absent when the fetch failed. */
  key?: string
  size?: number
  /** SHA-256 of the stored bytes, hex. The mirror's own record of what it has. */
  sha256?: string
  mirroredAt: string
  /** Why it isn't stored, when it isn't. */
  error?: string
}

export interface MirrorIndex {
  org: string
  updatedAt: string
  entries: MirrorRecord[]
}

export interface SnapshotResult {
  mirrored: number
  skipped: number
  failed: number
  entries: MirrorRecord[]
}

/** A tenant's storage prefix. Emails aren't key-safe; this makes them so. */
export function orgKey(org: string): string {
  return org
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._@-]/g, '_')
    .replace(/@/g, '_at_')
}

/** Reject names and versions that would escape the prefix. */
function safeSegment(value: string): string | null {
  const trimmed = String(value || '').trim()
  if (!trimmed || trimmed.length > 200) return null
  if (trimmed.includes('..') || trimmed.startsWith('/')) return null
  if (!/^[\w@./+-]+$/.test(trimmed)) return null
  return trimmed.replace(/\//g, '_')
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** `sha256-<base64>` / `sha512-<base64>` → the hex we compare against. */
function integrityMatches(integrity: string | undefined, hex: string): boolean {
  if (!integrity) return true // nothing to check against
  const [algorithm, encoded] = integrity.split('-')
  if (algorithm !== 'sha256' || !encoded) return true // only sha256 is comparable here
  try {
    const expected = Array.from(Buffer.from(encoded, 'base64')).map(b => b.toString(16).padStart(2, '0')).join('')
    return expected === hex
  }
  catch {
    return true
  }
}

/** Fetch an artifact. Injectable so tests never touch the network. */
export type ArtifactFetcher = (url: string) => Promise<ArrayBuffer>

const defaultFetcher: ArtifactFetcher = async (url) => {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}

export interface MirrorOptions {
  /** Largest artifact to mirror. Bigger ones are recorded but not stored. */
  maxArtifactBytes?: number
  /** Most artifacts to fetch in one snapshot call. */
  maxEntries?: number
  fetcher?: ArtifactFetcher
}

export class MirrorStore {
  private storage: TarballStorage
  private fetcher: ArtifactFetcher
  private maxArtifactBytes: number
  private maxEntries: number

  constructor(storage: TarballStorage, options: MirrorOptions = {}) {
    this.storage = storage
    this.fetcher = options.fetcher || defaultFetcher
    this.maxArtifactBytes = options.maxArtifactBytes ?? 200 * 1024 * 1024
    this.maxEntries = options.maxEntries ?? 2000
  }

  private indexKey(org: string): string {
    return `mirror/${orgKey(org)}/index.json`
  }

  async getIndex(org: string): Promise<MirrorIndex> {
    try {
      const bytes = await this.storage.download(this.indexKey(org))
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as MirrorIndex
      if (parsed && Array.isArray(parsed.entries)) return parsed
    }
    catch {
      // No index yet — an org that has never snapshotted.
    }
    return { org, updatedAt: new Date().toISOString(), entries: [] }
  }

  private async putIndex(index: MirrorIndex): Promise<void> {
    const body = new TextEncoder().encode(JSON.stringify(index)).buffer as ArrayBuffer
    await this.storage.upload(this.indexKey(index.org), body)
  }

  /**
   * Mirror a set of artifacts for an org.
   *
   * Already-mirrored entries are skipped by (name, version, integrity): the
   * integrity is part of the identity precisely so that a version republished
   * with different bytes is treated as new, which is the retag case this whole
   * feature exists to survive.
   */
  async snapshot(org: string, entries: MirrorEntry[]): Promise<SnapshotResult> {
    const index = await this.getIndex(org)
    const existing = new Map(index.entries.map(e => [`${e.name}@${e.version}:${e.integrity || ''}`, e]))

    let mirrored = 0
    let skipped = 0
    let failed = 0
    const touched: MirrorRecord[] = []

    for (const entry of entries.slice(0, this.maxEntries)) {
      const name = safeSegment(entry.name)
      const version = safeSegment(entry.version)
      if (!name || !version) {
        failed++
        continue
      }

      const identity = `${entry.name}@${entry.version}:${entry.integrity || ''}`
      const already = existing.get(identity)
      if (already?.key) {
        skipped++
        touched.push(already)
        continue
      }

      const record: MirrorRecord = {
        ...entry,
        mirroredAt: new Date().toISOString(),
      }

      if (!entry.resolved) {
        record.error = 'no download URL'
        failed++
        existing.set(identity, record)
        touched.push(record)
        continue
      }

      try {
        const bytes = await this.fetcher(entry.resolved)
        if (bytes.byteLength > this.maxArtifactBytes) {
          record.error = `artifact is larger than the ${Math.round(this.maxArtifactBytes / (1024 * 1024))}MB mirror limit`
          failed++
        }
        else {
          const hex = await sha256Hex(bytes)
          if (!integrityMatches(entry.integrity, hex)) {
            // The bytes upstream no longer match what the lockfile recorded.
            // Storing them would mirror the tampering, so refuse and say so.
            record.error = 'integrity mismatch — upstream bytes differ from the lockfile'
            failed++
          }
          else {
            const key = `mirror/${orgKey(org)}/${name}/${version}/${hex.slice(0, 32)}.tgz`
            await this.storage.upload(key, bytes)
            record.key = key
            record.size = bytes.byteLength
            record.sha256 = hex
            mirrored++
          }
        }
      }
      catch (err) {
        record.error = (err as Error).message
        failed++
      }

      existing.set(identity, record)
      touched.push(record)
    }

    const next: MirrorIndex = {
      org,
      updatedAt: new Date().toISOString(),
      entries: [...existing.values()],
    }
    await this.putIndex(next)

    return { mirrored, skipped, failed, entries: touched }
  }

  /** The stored bytes for one artifact, or null when this org hasn't got it. */
  async fetchArtifact(org: string, name: string, version: string): Promise<{ bytes: ArrayBuffer, record: MirrorRecord } | null> {
    const index = await this.getIndex(org)
    // Newest first, so a retagged version resolves to what was mirrored last.
    const matches = index.entries
      .filter(e => e.name === name && e.version === version && e.key)
      .sort((a, b) => b.mirroredAt.localeCompare(a.mirroredAt))

    for (const record of matches) {
      try {
        return { bytes: await this.storage.download(record.key!), record }
      }
      catch {
        // Stored object is gone; try an older copy of the same version.
      }
    }
    return null
  }

  /** Everything this org has insured, newest first. */
  async list(org: string): Promise<MirrorRecord[]> {
    const index = await this.getIndex(org)
    return [...index.entries].sort((a, b) => b.mirroredAt.localeCompare(a.mirroredAt))
  }

  async stats(org: string): Promise<{ artifacts: number, stored: number, bytes: number, failed: number }> {
    const entries = await this.list(org)
    return {
      artifacts: entries.length,
      stored: entries.filter(e => e.key).length,
      bytes: entries.reduce((sum, e) => sum + (e.size || 0), 0),
      failed: entries.filter(e => e.error).length,
    }
  }
}

/** Parse the entries a client sends, dropping anything malformed. */
export function normalizeEntries(value: unknown): MirrorEntry[] {
  if (!Array.isArray(value)) return []
  const out: MirrorEntry[] = []

  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (typeof entry.name !== 'string' || typeof entry.version !== 'string') continue
    out.push({
      name: entry.name,
      version: entry.version,
      resolved: typeof entry.resolved === 'string' ? entry.resolved : undefined,
      integrity: typeof entry.integrity === 'string' ? entry.integrity : undefined,
      ecosystem: typeof entry.ecosystem === 'string' ? entry.ecosystem : undefined,
      license: typeof entry.license === 'string' ? entry.license : undefined,
    })
  }

  return out
}
