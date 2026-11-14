import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'

/**
 * The newest glibc a published Linux package may require.
 *
 * A dynamically linked ELF file records, per symbol, the glibc version that
 * introduced it (`GLIBC_2.39`), and the loader of an older system refuses the
 * whole file: "version `GLIBC_2.43' not found". The build host's glibc is
 * therefore the oldest system the package can start on.
 *
 * 2.39 is Ubuntu 24.04, the image every Linux build ran on until GitHub moved
 * `ubuntu-latest` to 26.04 (glibc 2.43) in November 2026 and the oldest system
 * the catalog has ever been able to promise: artifacts published before then
 * already require up to 2.39. Lowering the floor means building in an older
 * environment first (see `.github/workflows`, every Linux build leg is pinned
 * to `ubuntu-24.04` / `ubuntu-24.04-arm`) and rebuilding what was published
 * above the new floor; raising it strands every machine on the old one.
 */
export const GLIBC_FLOOR = '2.39'

const SHT_GNU_VERNEED = 0x6FFFFFFE

function compare(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function highest(versions: Iterable<string>): string | null {
  let best: string | null = null
  for (const version of versions) {
    if (best === null || compare(version, best) > 0) best = version
  }
  return best
}

export function isElf(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x7F && bytes[1] === 0x45 && bytes[2] === 0x4C && bytes[3] === 0x46
}

/**
 * The highest `GLIBC_x.y` version an ELF file requires, or null when it
 * requires none (static, musl, not ELF).
 *
 * Reads the version-requirement section (`readelf --version-info`'s
 * `.gnu.version_r`) rather than searching for the text, because glibc's own
 * libraries carry every version name as a definition without requiring any of
 * them. A file whose section table was stripped has nothing to read that way,
 * so there the names in its string data decide.
 */
export function requiredGlibcVersion(bytes: Uint8Array): string | null {
  if (!isElf(bytes) || bytes.length < 52) return null
  const wide = bytes[4] === 2
  const little = bytes[5] !== 2
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const word = (offset: number): number => view.getUint32(offset, little)
  const address = (offset: number): number => wide ? Number(view.getBigUint64(offset, little)) : word(offset)
  const names = new Set<string>()

  try {
    const table = address(wide ? 0x28 : 0x20)
    const entrySize = view.getUint16(wide ? 0x3A : 0x2E, little)
    const count = view.getUint16(wide ? 0x3C : 0x30, little)
    if (table === 0 || count === 0) return highest(namedGlibcVersions(bytes))
    const section = (index: number): { type: number, offset: number, size: number, link: number, info: number } => {
      const at = table + index * entrySize
      return wide
        ? { type: word(at + 4), offset: address(at + 0x18), size: address(at + 0x20), link: word(at + 0x28), info: word(at + 0x2C) }
        : { type: word(at + 4), offset: word(at + 0x10), size: word(at + 0x14), link: word(at + 0x18), info: word(at + 0x1C) }
    }
    for (let index = 0; index < count; index++) {
      const needs = section(index)
      if (needs.type !== SHT_GNU_VERNEED) continue
      const strings = section(needs.link)
      const name = (offset: number): string => {
        const start = strings.offset + offset
        let end = start
        while (end < bytes.length && bytes[end] !== 0) end++
        return Buffer.from(bytes.subarray(start, end)).toString('latin1')
      }
      let entry = needs.offset
      for (let file = 0; file < needs.info; file++) {
        const auxiliaries = view.getUint16(entry + 2, little)
        let auxiliary = entry + word(entry + 8)
        for (let item = 0; item < auxiliaries; item++) {
          names.add(name(word(auxiliary + 8)))
          const next = word(auxiliary + 12)
          if (next === 0) break
          auxiliary += next
        }
        const next = word(entry + 12)
        if (next === 0) break
        entry += next
      }
    }
  }
  catch (error) {
    // A truncated or corrupt table reads past the end. Refusing to guess would
    // let exactly the file nobody can inspect through, so fall back to names.
    if (!(error instanceof RangeError)) throw error
    return highest(namedGlibcVersions(bytes))
  }

  return highest([...names].flatMap(name => /^GLIBC_(\d+\.\d+(?:\.\d+)?)$/.exec(name)?.[1] ?? []))
}

function namedGlibcVersions(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  return [...text.matchAll(/GLIBC_(\d+\.\d+(?:\.\d+)?)\0/g)].map(match => match[1])
}

export interface GlibcRequirement {
  path: string
  version: string
}

/** Every ELF file in a `.tar.gz` that requires glibc, with the version it requires. */
export async function tarballGlibcRequirements(tarball: string): Promise<GlibcRequirement[]> {
  const found: GlibcRequirement[] = []
  let pending = Buffer.alloc(0)
  let longName: string | null = null
  // The entry being read: how much of it is left, its padding, and its bytes
  // when it turned out to be ELF (anything else is skipped without buffering).
  let entry: { path: string, remaining: number, padding: number, chunks: Buffer[] | null, started: boolean, meta: boolean } | null = null

  const finish = (): void => {
    if (!entry) return
    if (entry.chunks) {
      const bytes = Buffer.concat(entry.chunks)
      if (entry.meta) longName = bytes.toString('utf8').replace(/\0.*$/su, '')
      else {
        const version = requiredGlibcVersion(bytes)
        if (version) found.push({ path: entry.path, version })
      }
    }
    entry = null
  }

  for await (const chunk of createReadStream(tarball).pipe(createGunzip())) {
    pending = pending.length ? Buffer.concat([pending, chunk as Buffer]) : chunk as Buffer
    for (;;) {
      if (entry) {
        if (entry.remaining > 0) {
          if (!pending.length) break
          const part = pending.subarray(0, Math.min(entry.remaining, pending.length))
          if (!entry.started) {
            // Wait for the magic before deciding whether to keep the entry.
            if (part.length < 4 && entry.remaining >= 4) break
            entry.started = true
            if (!entry.meta && !isElf(part)) entry.chunks = null
          }
          entry.chunks?.push(Buffer.from(part))
          entry.remaining -= part.length
          pending = pending.subarray(part.length)
          continue
        }
        if (pending.length < entry.padding) break
        pending = pending.subarray(entry.padding)
        finish()
        continue
      }
      if (pending.length < 512) break
      const header = pending.subarray(0, 512)
      pending = pending.subarray(512)
      if (header.every(byte => byte === 0)) continue
      const field = (start: number, length: number): string => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/su, '')
      const size = Number.parseInt(field(124, 12).trim() || '0', 8)
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Unreadable tar entry size in ${tarball}`)
      const type = field(156, 1)
      const prefix = field(345, 155)
      const path = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
      // 'L' is GNU tar's long name for the next entry; pax headers ('x', 'g')
      // can rename it too but only matter for the message, so they are skipped.
      const meta = type === 'L'
      if (!meta) longName = null
      const regular = type === '0' || type === '' || type === '7'
      entry = {
        path,
        remaining: size,
        padding: (512 - (size % 512)) % 512,
        chunks: meta || regular ? [] : null,
        started: false,
        meta,
      }
    }
  }
  finish()
  return found
}

/**
 * Refuse a Linux package that cannot start on the supported glibc floor.
 * Returns how many ELF files were checked against it.
 */
export async function verifyGlibcFloor(tarball: string, floor: string = GLIBC_FLOOR): Promise<number> {
  const requirements = await tarballGlibcRequirements(tarball)
  const above = requirements.filter(requirement => compare(requirement.version, floor) > 0)
  if (above.length) {
    const worst = highest(above.map(requirement => requirement.version))
    const listed = above.slice(0, 5).map(requirement => `${requirement.path} (GLIBC_${requirement.version})`).join(', ')
    throw new Error(
      `Requires glibc ${worst}, newer than the supported floor ${floor}: ${listed}`
      + `${above.length > 5 ? ` and ${above.length - 5} more` : ''}. Build it on a host with glibc ${floor} or older.`,
    )
  }
  return requirements.length
}
