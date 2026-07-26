/**
 * SBOM and provenance export.
 *
 * An org that has told the registry what it installs — for build insurance or
 * for security alerts — has already handed over exactly the inventory an SBOM
 * describes. So producing one is a formatting job, not a new data-collection
 * problem, and it comes out in the two formats auditors actually ask for:
 * CycloneDX and SPDX.
 *
 * Provenance is included where we have it: the integrity hash the lockfile
 * recorded, the SHA-256 the mirror computed from the bytes it actually stored,
 * and where it was fetched from. That's a real chain — "this is the file, this
 * is its hash, this is where it came from" — rather than a claim.
 */

import type { MirrorRecord } from './mirror'

export type SbomFormat = 'cyclonedx' | 'spdx'

export interface SbomOptions {
  org: string
  /** Name of the thing the SBOM describes. */
  subject?: string
  /** Fixed timestamp, so the same inventory produces byte-identical output. */
  timestamp?: string
  /** Fixed document id, for the same reason. */
  documentId?: string
}

/**
 * A Package URL for an entry, which is how both formats identify a component
 * unambiguously across ecosystems.
 */
export function purlFor(entry: { name: string, version: string, ecosystem?: string }): string {
  const type = (entry.ecosystem || 'npm').toLowerCase()
  const [scope, bare] = entry.name.startsWith('@')
    ? [entry.name.slice(0, entry.name.indexOf('/')), entry.name.slice(entry.name.indexOf('/') + 1)]
    : [null, entry.name]

  const namespace = scope ? `${encodeURIComponent(scope)}/` : ''
  return `pkg:${type}/${namespace}${encodeURIComponent(bare)}@${encodeURIComponent(entry.version)}`
}

/** The hashes we can vouch for, in CycloneDX's shape. */
function hashesFor(entry: MirrorRecord): { alg: string, content: string }[] {
  const hashes: { alg: string, content: string }[] = []
  if (entry.sha256) hashes.push({ alg: 'SHA-256', content: entry.sha256 })

  // The integrity string from the lockfile, when it's a form SBOM tools read.
  if (entry.integrity?.startsWith('sha512-')) {
    try {
      const hex = Array.from(Buffer.from(entry.integrity.slice(7), 'base64'))
        .map(b => b.toString(16).padStart(2, '0')).join('')
      hashes.push({ alg: 'SHA-512', content: hex })
    }
    catch {
      // Malformed integrity — omit rather than emit something wrong.
    }
  }

  return hashes
}

/** CycloneDX 1.5, the format most scanners ingest. */
export function toCycloneDx(entries: MirrorRecord[], options: SbomOptions): Record<string, unknown> {
  const timestamp = options.timestamp || new Date().toISOString()

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${options.documentId || deterministicUuid(options.org, timestamp)}`,
    version: 1,
    metadata: {
      timestamp,
      tools: [{ vendor: 'pantry', name: 'pantry-registry', version: '1' }],
      component: {
        type: 'application',
        name: options.subject || options.org,
        version: timestamp.slice(0, 10),
      },
    },
    components: entries.map(entry => ({
      type: 'library',
      name: entry.name,
      version: entry.version,
      purl: purlFor(entry),
      ...(entry.license ? { licenses: [{ license: { id: entry.license } }] } : {}),
      ...(hashesFor(entry).length ? { hashes: hashesFor(entry) } : {}),
      ...(entry.resolved
        ? { externalReferences: [{ type: 'distribution', url: entry.resolved }] }
        : {}),
      properties: [
        { name: 'pantry:mirrored', value: entry.key ? 'true' : 'false' },
        ...(entry.mirroredAt ? [{ name: 'pantry:mirroredAt', value: entry.mirroredAt }] : []),
      ],
    })),
  }
}

/** SPDX 2.3 in its JSON form, which is what compliance teams tend to ask for. */
export function toSpdx(entries: MirrorRecord[], options: SbomOptions): Record<string, unknown> {
  const timestamp = options.timestamp || new Date().toISOString()
  const name = options.subject || options.org

  const packages = entries.map((entry, i) => ({
    SPDXID: `SPDXRef-Package-${i}`,
    name: entry.name,
    versionInfo: entry.version,
    downloadLocation: entry.resolved || 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: entry.license || 'NOASSERTION',
    licenseDeclared: entry.license || 'NOASSERTION',
    copyrightText: 'NOASSERTION',
    externalRefs: [{
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: purlFor(entry),
    }],
    ...(entry.sha256
      ? { checksums: [{ algorithm: 'SHA256', checksumValue: entry.sha256 }] }
      : {}),
  }))

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name,
    documentNamespace: `https://pantry.dev/sbom/${encodeURIComponent(options.org)}/${options.documentId || deterministicUuid(options.org, timestamp)}`,
    creationInfo: {
      created: timestamp,
      creators: ['Tool: pantry-registry'],
    },
    packages,
    relationships: packages.map(pkg => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relatedSpdxElement: pkg.SPDXID,
      relationshipType: 'DESCRIBES',
    })),
  }
}

export function buildSbom(entries: MirrorRecord[], format: SbomFormat, options: SbomOptions): Record<string, unknown> {
  return format === 'spdx' ? toSpdx(entries, options) : toCycloneDx(entries, options)
}

export function parseFormat(value: string | null | undefined): SbomFormat {
  return String(value || '').toLowerCase() === 'spdx' ? 'spdx' : 'cyclonedx'
}

/**
 * A UUID derived from the org and timestamp rather than randomness, so
 * regenerating an SBOM for the same inventory produces the same document
 * instead of a spurious diff in whatever repo it's committed to.
 */
function deterministicUuid(org: string, timestamp: string): string {
  const seed = `${org}:${timestamp}`
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0
    h2 = Math.imul(h2 + seed.charCodeAt(i) + i, 0x85ebca6b) >>> 0
  }
  const hex = (n: number): string => n.toString(16).padStart(8, '0')
  const a = hex(h1)
  const b = hex(h2)
  const c = hex((h1 ^ h2) >>> 0)
  const d = hex((h1 + h2) >>> 0)
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-a${c.slice(1, 4)}-${c.slice(4)}${d}`
}
