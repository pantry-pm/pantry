/**
 * Shared recipe helper: read a font's version from its TTF/OTF `name` table.
 *
 * OpenType fonts record their version in name ID 5 ("Version 3.003"). This is the
 * authoritative, vendor-independent version signal — letting font recipes that
 * have no GitHub releases / appcast (e.g. Lato, Open Sans) still auto-update by
 * fetching a canonical TTF and parsing the embedded version. Returns the numeric
 * version (e.g. "3.003") or null if it can't be determined.
 */
export async function fontVersionFromTtf(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok)
      return null
    const data = new DataView(await res.arrayBuffer())

    const numTables = data.getUint16(4)
    let nameOff: number | null = null
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16
      const tag = String.fromCharCode(
        data.getUint8(rec), data.getUint8(rec + 1), data.getUint8(rec + 2), data.getUint8(rec + 3),
      )
      if (tag === 'name') {
        nameOff = data.getUint32(rec + 8)
        break
      }
    }
    if (nameOff == null)
      return null

    const count = data.getUint16(nameOff + 2)
    const strOff = nameOff + data.getUint16(nameOff + 4)
    for (let i = 0; i < count; i++) {
      const rec = nameOff + 6 + i * 12
      const platformId = data.getUint16(rec)
      const nameId = data.getUint16(rec + 6)
      const len = data.getUint16(rec + 8)
      const off = data.getUint16(rec + 10)
      if (nameId !== 5)
        continue
      const bytes = new Uint8Array(data.buffer, strOff + off, len)
      // Windows/Unicode platforms store UTF-16BE; Mac platform (1) stores latin-1.
      let str: string
      if (platformId === 1) {
        str = String.fromCharCode(...bytes)
      }
      else {
        // Decode UTF-16BE manually — 'utf-16be' isn't in TextDecoder's typed
        // label union, and decoding big-endian pairs here avoids the dependency.
        let out = ''
        for (let b = 0; b + 1 < bytes.length; b += 2)
          out += String.fromCharCode((bytes[b] << 8) | bytes[b + 1])
        str = out
      }
      const m = str.match(/(\d+\.\d+)/)
      if (m)
        return m[1]
    }
    return null
  }
  catch {
    return null
  }
}
