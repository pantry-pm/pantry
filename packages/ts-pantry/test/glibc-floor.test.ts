import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GLIBC_FLOOR, requiredGlibcVersion, tarballGlibcRequirements, verifyGlibcFloor } from '../scripts/glibc-floor'
import { uploadToS3 } from '../scripts/upload-to-s3'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A minimal ELF file whose only content is a version-requirement section. */
function elf(versions: string[], options: { wide?: boolean, little?: boolean, sections?: boolean } = {}): Uint8Array {
  const { wide = true, little = true, sections = true } = options
  const header = wide ? 64 : 52
  const sectionSize = wide ? 64 : 40
  const names = ['', 'libc.so.6', ...versions]
  const offsets: number[] = []
  let strings = ''
  for (const name of names) {
    offsets.push(strings.length)
    strings += `${name}\0`
  }
  const needsSize = 16 + 16 * versions.length
  const needsAt = header
  const stringsAt = needsAt + needsSize
  const tableAt = stringsAt + strings.length
  const bytes = new Uint8Array(tableAt + sectionSize * 3)
  bytes.set([0x7F, 0x45, 0x4C, 0x46, wide ? 2 : 1, little ? 1 : 2, 1])
  const view = new DataView(bytes.buffer)
  if (sections) {
    if (wide) view.setBigUint64(0x28, BigInt(tableAt), little)
    else view.setUint32(0x20, tableAt, little)
    view.setUint16(wide ? 0x3A : 0x2E, sectionSize, little)
    view.setUint16(wide ? 0x3C : 0x30, 3, little)
  }
  // Verneed: one file (libc.so.6) with one Vernaux per version.
  view.setUint16(needsAt, 1, little)
  view.setUint16(needsAt + 2, versions.length, little)
  view.setUint32(needsAt + 4, offsets[1], little)
  view.setUint32(needsAt + 8, 16, little)
  versions.forEach((_, index) => {
    const at = needsAt + 16 + index * 16
    view.setUint32(at + 8, offsets[index + 2], little)
    view.setUint32(at + 12, index === versions.length - 1 ? 0 : 16, little)
  })
  bytes.set(Buffer.from(strings, 'latin1'), stringsAt)
  const section = (index: number, type: number, offset: number, size: number, link: number, info: number): void => {
    const at = tableAt + index * sectionSize
    view.setUint32(at + 4, type, little)
    if (wide) {
      view.setBigUint64(at + 0x18, BigInt(offset), little)
      view.setBigUint64(at + 0x20, BigInt(size), little)
      view.setUint32(at + 0x28, link, little)
      view.setUint32(at + 0x2C, info, little)
    }
    else {
      view.setUint32(at + 0x10, offset, little)
      view.setUint32(at + 0x14, size, little)
      view.setUint32(at + 0x18, link, little)
      view.setUint32(at + 0x1C, info, little)
    }
  }
  section(1, 0x6FFFFFFE, needsAt, needsSize, 2, 1)
  section(2, 3, stringsAt, strings.length, 0, 0)
  return bytes
}

function tarball(files: Record<string, Uint8Array | string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pantry-glibc-floor-'))
  roots.push(root)
  const prefix = join(root, 'prefix')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(prefix, path, '..'), { recursive: true })
    writeFileSync(join(prefix, path), content)
  }
  const archive = join(root, 'package.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', prefix, '.'])
  return archive
}

test('reads the highest glibc version an ELF file requires', () => {
  expect(requiredGlibcVersion(elf(['GLIBC_2.2.5', 'GLIBC_2.43', 'GLIBC_2.34']))).toBe('2.43')
  expect(requiredGlibcVersion(elf(['GLIBC_2.17', 'GLIBC_2.39'], { wide: false }))).toBe('2.39')
  expect(requiredGlibcVersion(elf(['GLIBC_2.28'], { little: false }))).toBe('2.28')
  // 2.4 is older than 2.39: versions compare by component, not as decimals.
  expect(requiredGlibcVersion(elf(['GLIBC_2.4', 'GLIBC_2.39']))).toBe('2.39')
  expect(requiredGlibcVersion(elf(['GLIBC_PRIVATE', 'GLIBCXX_3.4.33', 'GCC_14.0']))).toBeNull()
  expect(requiredGlibcVersion(new TextEncoder().encode('#!/bin/sh\necho GLIBC_2.99\n'))).toBeNull()
})

test('falls back to the version names when the section table is stripped', () => {
  expect(requiredGlibcVersion(elf(['GLIBC_2.14', 'GLIBC_2.41'], { sections: false }))).toBe('2.41')
})

test('finds the requirements of every ELF file in a package archive', async () => {
  const deep = `share/${'nested-directory/'.repeat(9)}plugin.so`
  const archive = tarball({
    'bin/curl': elf(['GLIBC_2.34', 'GLIBC_2.43']),
    'bin/static': elf([]),
    'lib/libcurl.so.4.8.0': elf(['GLIBC_2.38']),
    'share/doc/README': 'GLIBC_2.99 is only text here\n',
    [deep]: elf(['GLIBC_2.40']),
    'share/large.bin': new Uint8Array(3 * 1024 * 1024).fill(7),
  })
  const found = await tarballGlibcRequirements(archive)
  expect(found.map(item => [item.path.replace(/^\.\//, ''), item.version]).sort()).toEqual([
    ['bin/curl', '2.43'],
    ['lib/libcurl.so.4.8.0', '2.38'],
    [deep, '2.40'],
  ])
})

test('accepts a package at the floor and refuses one above it', async () => {
  expect(GLIBC_FLOOR).toBe('2.39')
  expect(await verifyGlibcFloor(tarball({ 'bin/tool': elf(['GLIBC_2.2.5', 'GLIBC_2.39']), 'lib/libz.so': elf(['GLIBC_2.14']) }))).toBe(2)
  await expect(verifyGlibcFloor(tarball({ 'bin/curl': elf(['GLIBC_2.43']), 'lib/libcurl.so': elf(['GLIBC_2.43']) })))
    .rejects.toThrow(/Requires glibc 2\.43, newer than the supported floor 2\.39: .*bin\/curl \(GLIBC_2\.43\)/)
})

test('a Linux package above the floor is refused before it reaches the registry', async () => {
  const stage = (platform: string, versions: string[]): string => {
    const archive = tarball({ 'bin/curl': elf(versions) })
    const artifacts = join(archive, '..', 'artifacts')
    const directory = join(artifacts, `curl.se-8.23.0.3-${platform}`)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'curl.se-8.23.0.3.tar.gz'), readFileSync(archive))
    return artifacts
  }
  const requests: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requests.push(String(input instanceof Request ? input.url : input))
    throw new Error('registry reached')
  }) as unknown as typeof fetch
  try {
    const options = { package: 'curl.se', version: '8.23.0.3', registryUrl: 'http://127.0.0.1:9', token: 'test' }
    await expect(uploadToS3({ ...options, artifactsDir: stage('linux-x86-64', ['GLIBC_2.43']) })).rejects.toThrow(/newer than the supported floor 2\.39/)
    await expect(uploadToS3({ ...options, artifactsDir: stage('linux-arm64', ['GLIBC_2.40']) })).rejects.toThrow(/newer than the supported floor 2\.39/)
    expect(requests).toEqual([])
  }
  finally { globalThis.fetch = original }
})

test('every workflow that builds or publishes Linux packages pins a runner at the floor', () => {
  const directory = new URL('../../../.github/workflows/', import.meta.url)
  const builders = /build-all-packages\.ts|build-package\.ts|upload-to-s3\.ts|sync-packages\.ts|publish-zig-libs\.ts/
  const allowed = new Set(['ubuntu-24.04', 'ubuntu-24.04-arm', 'ubuntu-22.04', 'ubuntu-22.04-arm'])
  const checked: string[] = []
  for (const name of readdirSync(directory).filter(file => file.endsWith('.yml'))) {
    const source = readFileSync(new URL(name, directory), 'utf8')
    if (!builders.test(source)) continue
    checked.push(name)
    const runners = [...source.matchAll(/\bubuntu-[\w.-]+/g)].map(match => match[0])
    expect(runners.filter(runner => !allowed.has(runner)), `${name} must not build Linux packages on a floating or newer Ubuntu image`).toEqual([])
  }
  expect(checked).toContain('publish-changed-packages.yml')
  expect(checked).toContain('build.yml')
  expect(checked).toContain('mirror.yml')
})
