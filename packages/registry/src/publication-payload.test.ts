import { expect, test } from 'bun:test'
import { gzipSync, gunzipSync } from 'node:zlib'
import { pack, type Headers } from 'tar-stream'
import { publicationPayloadDigest } from './publication-verification'

type Entry = Headers & { body?: string, pax?: Record<string, string> }

async function archive(entries: Entry[]): Promise<ArrayBuffer> {
  const output = pack()
  for (const { body, ...header } of entries) output.entry({ mode: 0o644, mtime: new Date(0), ...header }, body)
  output.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of output) chunks.push(Buffer.from(chunk))
  return new Uint8Array(gzipSync(Buffer.concat(chunks))).buffer
}

const file: Entry = { name: 'source/main.ts', body: 'export const answer = 42\n' }

test('identifies every regular file and symlink independently of archive order', async () => {
  const link: Entry = { name: 'source/current.ts', type: 'symlink', linkname: 'main.ts', mode: 0o777 }
  expect(await publicationPayloadDigest(await archive([file, link]))).toBe(await publicationPayloadDigest(await archive([link, file])))
})

test('ignores portable ownership and time metadata while retaining root directories', async () => {
  const root: Entry = { name: './', type: 'directory', mode: 0o755 }
  expect(await publicationPayloadDigest(await archive([root, file]))).toBe(await publicationPayloadDigest(await archive([{ ...file, uid: 1001, gid: 1001, mtime: new Date(1_000_000) }, root])))
})

test('retains non-portable PAX attributes and ignores only declared portable metadata', async () => {
  const plain = await publicationPayloadDigest(await archive([file]))
  expect(await publicationPayloadDigest(await archive([{ ...file, pax: { mtime: '1000', uid: '1001' } }]))).toBe(plain)
  expect(await publicationPayloadDigest(await archive([{ ...file, pax: { 'SCHILY.xattr.fixture': 'different' } }]))).not.toBe(plain)
})

for (const [label, changed] of [
  ['file bytes', { ...file, body: 'export const answer = 43\n' }],
  ['filename', { ...file, name: 'source/other.ts' }],
  ['permissions', { ...file, mode: 0o755 }],
] as const) {
  test(`retains ${label}`, async () => {
    expect(await publicationPayloadDigest(await archive([changed]))).not.toBe(await publicationPayloadDigest(await archive([file])))
  })
}

for (const name of ['../escape.ts', '/absolute.ts', 'source\\ambiguous.ts', 'source/\ufffd.ts']) {
  test(`refuses ambiguous or unsafe path ${JSON.stringify(name)}`, async () => {
    await expect(publicationPayloadDigest(await archive([{ ...file, name }]))).rejects.toThrow()
  })
}

test('rejects duplicate normalized paths', async () => {
  await expect(publicationPayloadDigest(await archive([file, { ...file, name: './source/main.ts' }]))).rejects.toThrow('duplicate path')
})

test('does not treat zero-filled file data as a terminator', async () => {
  expect(await publicationPayloadDigest(await archive([{ ...file, body: '\0'.repeat(2048) }]))).toHaveLength(64)
})

test('rejects files hidden after a tar terminator', async () => {
  const raw = gunzipSync(Buffer.from(await archive([file])))
  const hidden = new Uint8Array(gzipSync(Buffer.concat([Buffer.alloc(1024), raw]))).buffer
  await expect(publicationPayloadDigest(hidden)).rejects.toThrow('after its terminator')
})

test('rejects truncated tar framing and invalid gzip data', async () => {
  const raw = gunzipSync(Buffer.from(await archive([file])))
  await expect(publicationPayloadDigest(new Uint8Array(gzipSync(raw.subarray(0, -1024))).buffer)).rejects.toThrow('terminator')
  await expect(publicationPayloadDigest(new TextEncoder().encode('not an archive').buffer)).rejects.toThrow()
})

test('rejects unsupported hard links and PAX size overrides', async () => {
  await expect(publicationPayloadDigest(await archive([file, { name: 'alias', type: 'link', linkname: file.name }]))).rejects.toThrow('unsupported')
  await expect(publicationPayloadDigest(await archive([{ ...file, pax: { size: '25' } }]))).rejects.toThrow()
})

test('bounds entry count and decompression and respects cancellation', async () => {
  const bytes = await archive([file, { ...file, name: 'second.ts' }])
  await expect(publicationPayloadDigest(bytes, { maxEntries: 1 })).rejects.toThrow('entry limit')
  await expect(publicationPayloadDigest(bytes, { maxUnpackedBytes: 512 })).rejects.toThrow('unpacked-byte limit')
  await expect(publicationPayloadDigest(bytes, { signal: AbortSignal.abort() })).rejects.toThrow()
})
