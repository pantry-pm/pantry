import { describe, expect, test } from 'bun:test'
import { classifyLoaderPath, classifyLoaderPathEntry, forEachElfMember, readElfLoaderPaths, selectArtifacts } from '../scripts/audit-elf-rpaths'

/** A minimal dynamic ELF64/ELF32 image: one PT_LOAD over the file, a PT_DYNAMIC, a string table. */
function elfWithLoaderPaths(paths: { rpath?: string, runpath?: string }, wide = true, little = true): Uint8Array {
  const header = wide ? 64 : 52
  const phentsize = wide ? 56 : 32
  const dynEntry = wide ? 16 : 8
  const strings = ['', paths.rpath, paths.runpath].filter(s => s !== undefined) as string[]
  const encoder = new TextEncoder()
  const table: number[] = []
  const offsets = new Map<string, number>()
  for (const s of strings) {
    if (!offsets.has(s)) {
      offsets.set(s, table.length)
      table.push(...encoder.encode(s), 0)
    }
  }
  const tags: Array<[number, number]> = []
  if (paths.rpath !== undefined) tags.push([15, offsets.get(paths.rpath)!])
  if (paths.runpath !== undefined) tags.push([29, offsets.get(paths.runpath)!])
  const dynOffset = header + phentsize * 2
  const strOffset = dynOffset + dynEntry * (tags.length + 2)
  const size = strOffset + table.length
  const vaddrBase = 0x400000
  tags.unshift([5, vaddrBase + strOffset])
  tags.push([0, 0])

  const bytes = new Uint8Array(size)
  const view = new DataView(bytes.buffer)
  bytes.set([0x7F, 0x45, 0x4C, 0x46, wide ? 2 : 1, little ? 1 : 2, 1])
  view.setUint16(16, 3, little)
  const setWord = (at: number, value: number): void => wide ? view.setBigUint64(at, BigInt(value), little) : view.setUint32(at, value, little)
  setWord(wide ? 32 : 28, header)
  view.setUint16(wide ? 54 : 42, phentsize, little)
  view.setUint16(wide ? 56 : 44, 2, little)
  const program = (index: number, type: number, offset: number, vaddr: number, filesz: number): void => {
    const at = header + index * phentsize
    view.setUint32(at, type, little)
    setWord(at + (wide ? 8 : 4), offset)
    setWord(at + (wide ? 16 : 8), vaddr)
    setWord(at + (wide ? 32 : 16), filesz)
  }
  program(0, 1, 0, vaddrBase, size)
  program(1, 2, dynOffset, vaddrBase + dynOffset, dynEntry * tags.length)
  tags.forEach(([tag, value], i) => {
    const at = dynOffset + i * dynEntry
    if (wide) {
      view.setBigInt64(at, BigInt(tag), little)
      view.setBigUint64(at + 8, BigInt(value), little)
    }
    else {
      view.setInt32(at, tag, little)
      view.setUint32(at + 4, value, little)
    }
  })
  bytes.set(table, strOffset)
  return bytes
}

function tarMember(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512)
  header.set(new TextEncoder().encode(name))
  header.set(new TextEncoder().encode(`${data.length.toString(8).padStart(11, '0')}\0`), 124)
  header[156] = 0x30
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
  padded.set(data)
  const out = new Uint8Array(512 + padded.length)
  out.set(header)
  out.set(padded, 512)
  return out
}

function streamOf(parts: Uint8Array[], chunk = 7): ReadableStream<Uint8Array> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0) + 1024)
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= all.length) return controller.close()
      controller.enqueue(all.slice(offset, offset + chunk))
      offset += chunk
    },
  })
}

describe('loader path classification', () => {
  test('an expanded $ORIGIN, an empty entry and a bare relative path are broken', () => {
    expect(classifyLoaderPathEntry('/../lib')).toBe('expanded-origin')
    expect(classifyLoaderPathEntry('/..')).toBe('expanded-origin')
    expect(classifyLoaderPathEntry('')).toBe('empty')
    expect(classifyLoaderPathEntry('../lib')).toBe('relative')
    expect(classifyLoaderPathEntry('lib')).toBe('relative')
  })

  test('$ORIGIN, loader tokens and absolute paths are not', () => {
    for (const entry of ['$ORIGIN', '$ORIGIN/../lib', '${ORIGIN}/../lib64', '$LIB', '/usr/lib', '/opt/pantry/lib'])
      expect(classifyLoaderPathEntry(entry)).toBeNull()
    expect(classifyLoaderPath('$ORIGIN/../lib:/usr/lib')).toEqual({ issues: [], absolute: 1 })
    expect(classifyLoaderPath('/../lib::$ORIGIN').issues.sort()).toEqual(['empty', 'expanded-origin'])
  })
})

describe('ELF dynamic section', () => {
  test('reads RPATH and RUNPATH through PT_LOAD in every class and byte order', () => {
    for (const wide of [true, false]) {
      for (const little of [true, false]) {
        expect(readElfLoaderPaths(elfWithLoaderPaths({ rpath: '/../lib' }, wide, little))).toEqual({ rpath: '/../lib' })
        expect(readElfLoaderPaths(elfWithLoaderPaths({ runpath: '$ORIGIN/../lib', rpath: '' }, wide, little))).toEqual({ rpath: '', runpath: '$ORIGIN/../lib' })
        expect(readElfLoaderPaths(elfWithLoaderPaths({}, wide, little))).toEqual({})
      }
    }
  })

  test('a non-ELF file has no loader paths', () => {
    expect(readElfLoaderPaths(new TextEncoder().encode('#!/bin/sh\necho not an ELF image at all, just a script\n'))).toBeNull()
  })
})

describe('tar streaming', () => {
  test('visits only ELF members, across arbitrary chunk boundaries', async () => {
    const elf = elfWithLoaderPaths({ rpath: '/../lib' })
    const seen: string[] = []
    await forEachElfMember(streamOf([
      tarMember('bin/script', new TextEncoder().encode('#!/bin/sh\nexit 0\n'.repeat(10))),
      tarMember('bin/zstd', elf),
      tarMember('share/doc.txt', new Uint8Array(1000).fill(65)),
      tarMember('lib/libzstd.so.1', elfWithLoaderPaths({})),
    ]), (path, bytes) => {
      seen.push(`${path}:${JSON.stringify(readElfLoaderPaths(bytes))}`)
    })
    expect(seen).toEqual(['bin/zstd:{"rpath":"/../lib"}', 'lib/libzstd.so.1:{}'])
  })
})

describe('artifact selection', () => {
  const cutoff = new Date('2026-10-17T00:00:00Z')
  const record = (uploadedAt: string): object => ({ tarball: `t-${uploadedAt}`, sha256: 'x', size: 10, uploadedAt })
  const metadata = {
    versions: {
      '1.5.6': { platforms: { 'linux-x86-64': record('2026-06-04T00:00:00Z') } },
      '1.5.7': { platforms: { 'linux-x86-64': record('2026-06-04T00:00:00Z'), 'linux-arm64': record('2026-06-04T00:00:00Z') } },
      '1.5.7.1': { platforms: { 'darwin-arm64': record('2026-11-13T00:00:00Z') } },
      '1.5.7.2': { platforms: { 'linux-x86-64': record('2026-11-13T00:00:00Z') } },
    },
  }

  test('the newest pre-cutoff artifact per platform, and what repaired it', () => {
    const selected = selectArtifacts('facebook.com/zstd', metadata, 'newest-before', cutoff)
    expect(selected.map(s => [s.platform, s.version, s.supersededBy, s.newestOnPlatform])).toEqual([
      ['linux-x86-64', '1.5.7', '1.5.7.2', false],
      ['linux-arm64', '1.5.7', undefined, true],
    ])
  })

  test('all-before takes every pre-cutoff artifact', () => {
    expect(selectArtifacts('facebook.com/zstd', metadata, 'all-before', cutoff, ['linux-x86-64']).map(s => s.version)).toEqual(['1.5.7', '1.5.6'])
  })
})

test('a dashless prerelease is older than its release when choosing the newest artifact', async () => {
  const { compareVersionStrings } = await import('../scripts/audit-elf-rpaths')
  expect(compareVersionStrings('3.15.0', '3.15.0rc1')).toBeGreaterThan(0)
  expect(compareVersionStrings('3.15.0rc1', '3.14.1')).toBeGreaterThan(0)
  expect(compareVersionStrings('3.15.0rc1.pantry1', '3.15.0rc1')).toBeGreaterThan(0)
  expect(compareVersionStrings('1.5.7.2', '1.5.7')).toBeGreaterThan(0)
  expect(compareVersionStrings('1.10.0', '1.9.9')).toBeGreaterThan(0)
})
