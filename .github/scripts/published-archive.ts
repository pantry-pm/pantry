import { gunzipSync } from 'node:zlib'

/** Inspect the uploaded tar headers, before an installer can normalize modes. */
export function archiveMember(archive: Uint8Array, member: string): { mode: number, type: string, link: string } | undefined {
  const tar = gunzipSync(archive)
  let longName: string | undefined
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start: number, length: number) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '')
    const size = Number.parseInt(field(124, 12).trim(), 8)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid uploaded tar header')
    const type = field(156, 1)
    const body = tar.subarray(offset + 512, offset + 512 + size)
    if (type === 'x') longName = /\d+ path=([^\n]+)\n/.exec(body.toString())?.[1]
    else if (type === 'L') longName = body.toString().replace(/\0.*$/s, '')
    else if (type !== 'g') {
      const prefix = field(345, 155)
      const name = longName ?? `${prefix ? `${prefix}/` : ''}${field(0, 100)}`
      if (name === member) return { mode: Number.parseInt(field(100, 8).trim(), 8), type, link: field(157, 100) }
      longName = undefined
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
}

export function archiveMemberMode(archive: Uint8Array, member: string): number | undefined {
  return archiveMember(archive, member)?.mode
}
