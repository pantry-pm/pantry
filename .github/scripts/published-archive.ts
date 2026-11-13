import { gunzipSync } from 'node:zlib'

/** Inspect the uploaded tar headers, before an installer can normalize modes. */
export function archiveMembers(archive: Uint8Array): Map<string, { mode: number, type: string, link: string, bytes: Uint8Array }> {
  const members = new Map<string, { mode: number, type: string, link: string, bytes: Uint8Array }>()
  const tar = gunzipSync(archive)
  let longName: string | undefined
  let longLink: string | undefined
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start: number, length: number) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '')
    const size = Number.parseInt(field(124, 12).trim(), 8)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid uploaded tar header')
    const type = field(156, 1)
    const body = tar.subarray(offset + 512, offset + 512 + size)
    if (type === 'x') {
      longName = /\d+ path=([^\n]+)\n/.exec(body.toString())?.[1]
      longLink = /\d+ linkpath=([^\n]+)\n/.exec(body.toString())?.[1]
    }
    else if (type === 'L') longName = body.toString().replace(/\0.*$/s, '')
    else if (type === 'K') longLink = body.toString().replace(/\0.*$/s, '')
    else if (type !== 'g') {
      const prefix = field(345, 155)
      const name = longName ?? `${prefix ? `${prefix}/` : ''}${field(0, 100)}`
      if (members.has(name)) throw new Error(`Duplicate uploaded tar member: ${name}`)
      members.set(name, { mode: Number.parseInt(field(100, 8).trim(), 8), type, link: longLink ?? field(157, 100), bytes: body })
      longName = undefined
      longLink = undefined
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return members
}

export function archiveMember(archive: Uint8Array, member: string): { mode: number, type: string, link: string } | undefined {
  const entry = archiveMembers(archive).get(member)
  return entry && { mode: entry.mode, type: entry.type, link: entry.link }
}

export function archiveMemberMode(archive: Uint8Array, member: string): number | undefined {
  return archiveMember(archive, member)?.mode
}
