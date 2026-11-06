import type { Registry } from './registry'
import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { extract } from 'tar-stream'
import { MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_OUTPUT_BYTES } from './malware-scanning'
import { restrictedAccessRequested } from './private-packages'

/** The same package limits apply to scanning and semantic retry verification. */
export interface PublicationArchiveLimits {
  maxEntries?: number
  maxUnpackedBytes?: number
  signal?: AbortSignal
}

/**
 * tar-stream accepts files after end-of-archive blocks. Installers may stop at
 * those blocks instead. Validate framing so two different extracted trees can
 * never acquire the same identity by moving a terminator between their files.
 */
function framing(maxBytes: number): Transform {
  const header = Buffer.alloc(512)
  let headerBytes = 0
  let remaining = 0
  let unpacked = 0
  let ended = false
  let endBytes = 0
  return new Transform({
    // Gzip emits binary chunks; the Transform callback still requires encoding.
    // eslint-disable-next-line ts/no-unused-vars
    transform(chunk: Buffer, encoding, callback) {
      try {
        unpacked += chunk.byteLength
        if (unpacked > maxBytes) throw new Error('Publication archive exceeds the unpacked-byte limit')
        let offset = 0
        while (offset < chunk.length) {
          if (ended) {
            if (chunk.subarray(offset).some(byte => byte !== 0)) throw new Error('Publication archive contains data after its terminator')
            endBytes += chunk.length - offset
            break
          }
          if (remaining) {
            const count = Math.min(remaining, chunk.length - offset)
            remaining -= count
            offset += count
            continue
          }
          const count = Math.min(512 - headerBytes, chunk.length - offset)
          chunk.copy(header, headerBytes, offset, offset + count)
          headerBytes += count
          offset += count
          if (headerBytes !== 512) continue
          headerBytes = 0
          if (header.every(byte => byte === 0)) {
            ended = true
            endBytes = 512
            continue
          }
          const raw = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
          if (!/^[0-7]*$/.test(raw)) throw new Error('Publication archive uses an unsupported size encoding')
          const size = Number.parseInt(raw || '0', 8)
          if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw new Error('Publication archive has an invalid entry size')
          remaining = Math.ceil(size / 512) * 512
        }
        callback(null, chunk)
      }
      catch (error) { callback(error instanceof Error ? error : new Error(String(error))) }
    },
    flush(callback) {
      callback(!ended || endBytes < 1024 || remaining || headerBytes
        ? new Error('Publication archive is truncated or has no complete terminator')
        : null)
    },
  })
}

function packagePath(name: string, directory: boolean): string {
  if (name.includes('\\') || name.includes('\ufffd') || name.startsWith('/')) throw new Error('Publication archive has an ambiguous path')
  const parts = name.split('/').filter(part => part !== '' && part !== '.')
  if (!parts.length && directory && /^\.(?:\/)*$/.test(name)) return '.'
  if (!parts.length || parts.includes('..')) throw new Error('Publication archive has an unsafe path')
  return parts.join('/')
}

/** Hash the installable tree, retaining modes, links and non-portable PAX data. */
export async function publicationPayloadDigest(bytes: ArrayBuffer, options: PublicationArchiveLimits = {}): Promise<string> {
  const maxEntries = options.maxEntries ?? MAX_ARCHIVE_ENTRIES
  const maxBytes = options.maxUnpackedBytes ?? MAX_ARCHIVE_OUTPUT_BYTES
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Publication archive limits must be positive safe integers')
  const unpack = extract()
  const paths = new Set<string>()
  // Store fixed-size hashes rather than attacker-controlled names or contents.
  const entries: string[] = []
  let files = 0
  unpack.on('entry', (header, stream, next) => {
    void (async () => {
      const name = packagePath(header.name, header.type === 'directory')
      const pathHash = createHash('sha256').update(name).digest('hex')
      if (paths.has(pathHash)) throw new Error('Publication archive contains a duplicate path')
      paths.add(pathHash)
      if (paths.size > maxEntries) throw new Error('Publication archive exceeds the entry limit')
      const type = header.type === 'contiguous-file' ? 'file' : header.type
      if (type !== 'file' && type !== 'directory' && type !== 'symlink') throw new Error('Publication archive contains an unsupported entry type')
      const mode = header.mode
      if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('Publication archive contains an invalid mode')
      const size = header.size
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || (type !== 'file' && size !== 0)) throw new Error('Publication archive contains an invalid size')
      const link = type === 'symlink' ? header.linkname : null
      if (type === 'symlink' && (typeof link !== 'string' || link.includes('\ufffd'))) throw new Error('Publication archive has an ambiguous link')
      const attributes: Array<[string, string]> = []
      if ('pax' in header && header.pax != null) {
        if (typeof header.pax !== 'object' || Array.isArray(header.pax)) throw new Error('Publication archive has invalid PAX attributes')
        for (const [key, value] of Object.entries(header.pax)) {
          if (typeof value !== 'string' || key === 'size') throw new Error('Publication archive has unsupported PAX attributes')
          if (!['path', 'linkpath', 'uid', 'gid', 'uname', 'gname', 'mtime', 'atime', 'ctime', 'birthtime'].includes(key)) attributes.push([key, value])
        }
      }
      attributes.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      const digest = createHash('sha256').update(JSON.stringify(['pantry-entry-v1', name, type, mode, link, size, attributes])).update('\0')
      let actualSize = 0
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) throw new Error('Publication archive yielded non-binary data')
        actualSize += chunk.byteLength
        digest.update(chunk)
      }
      if (actualSize !== size) throw new Error('Publication archive entry is truncated')
      if (type === 'file') files++
      entries.push(digest.digest('hex'))
      next()
    })().catch(error => unpack.destroy(error instanceof Error ? error : new Error(String(error))))
  })
  await pipeline(Readable.from(Buffer.from(bytes)), createGunzip(), framing(maxBytes), unpack, { signal: options.signal })
  if (!files) throw new Error('Publication archive contains no regular files')
  return createHash('sha256').update('pantry-payload-v1\0').update(entries.sort().join('\n')).digest('hex')
}

/** Called only after publish authentication, ownership and artifact-size checks. */
export async function verifyExistingPublication(
  registry: Registry,
  metadata: { name: string, version: string, publishConfig?: unknown },
  candidate: ArrayBuffer,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const responseHeaders = { ...headers, 'Cache-Control': 'private, no-store' }
  const conflict = () => Response.json({ error: 'Version already exists with a different or unverifiable payload', code: 'PUBLICATION_PAYLOAD_CONFLICT' }, { status: 409, headers: responseHeaders })
  const record = await registry.getPublisherPackageRecord(metadata.name)
  const version = record?.versions[metadata.version]
  if (!record || !version || version.malwareScan?.verdict !== 'clean' || `sha256:${version.malwareScan.artifactSha256}` !== version.checksum) return conflict()
  const visibility = record.settings?.visibility || 'public'
  if (restrictedAccessRequested(metadata, candidate) && visibility !== 'private') return conflict()
  const existing = await registry.downloadTarball(metadata.name, metadata.version, { recordDownload: false, allowFallback: false })
  if (!existing || `sha256:${createHash('sha256').update(new Uint8Array(existing)).digest('hex')}` !== version.checksum) {
    return Response.json({ error: 'Existing artifact is unavailable for verification', code: 'PUBLICATION_VERIFICATION_UNAVAILABLE' }, { status: 503, headers: responseHeaders })
  }
  const checksum = `sha256:${createHash('sha256').update(new Uint8Array(candidate)).digest('hex')}`
  let verification = 'archive-sha256'
  let payloadSha256: string | undefined
  if (checksum !== version.checksum) {
    try {
      const expected = await publicationPayloadDigest(existing, { signal })
      payloadSha256 = await publicationPayloadDigest(candidate, { signal })
      if (payloadSha256 !== expected) return conflict()
      verification = 'payload-sha256-v1'
    }
    catch { return conflict() }
  }
  return Response.json({ success: true, action: 'verified-existing', message: `Verified existing ${metadata.name}@${metadata.version}; publication unchanged`, name: metadata.name, version: metadata.version, checksum: version.checksum, verification, ...(payloadSha256 ? { payloadSha256 } : {}), visibility }, { headers: responseHeaders })
}
