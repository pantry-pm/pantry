import { expect, test } from 'bun:test'
import snapshot from '../../../catalog/packages.json'
import { createPackageCatalogSearch, fetchPackageCatalog, parsePackageCatalog, searchPackageCatalog } from '../src/catalog/client'

test('a prepared catalog searches a stable snapshot without rebuilding metadata per keystroke', () => {
  const entries = parsePackageCatalog(snapshot)
  const original = entries.map(entry => entry.domain)
  const search = createPackageCatalogSearch(entries)
  for (const query of ['', 'git', ' GIT ', 'source code', 'figma', 'libsodium', 'no-such-package-xyz']) {
    for (const kind of [undefined, 'app', 'cli', 'library', 'font'] as const) {
      expect(search(query, { kind, limit: 7 })).toEqual(searchPackageCatalog(entries, query, { kind, limit: 7 }))
    }
  }
  expect(entries.map(entry => entry.domain)).toEqual(original)
  const entry = { ...entries[0]! }
  let reads = 0
  Object.defineProperty(entry, 'description', { get: () => { reads++; return 'Snapshot metadata' } })
  const prepared = createPackageCatalogSearch([entry])
  const initialReads = reads
  prepared('snapshot')
  prepared('metadata')
  expect(reads).toBe(initialReads)
  expect(createPackageCatalogSearch([])('git')).toEqual([])
})

test('the complete catalog is valid and includes desktop apps, CLIs, libraries and fonts', () => {
  const entries = parsePackageCatalog(snapshot)
  expect(entries.length).toBeGreaterThan(1700)
  expect(searchPackageCatalog(entries, '', { limit: 50000 })).toHaveLength(entries.length)
  for (const kind of ['app', 'cli', 'library', 'font']) expect(entries.some(entry => entry.kind === kind)).toBe(true)
  expect(searchPackageCatalog(entries, 'git')[0]?.domain).toBe('git-scm.org')
  expect(searchPackageCatalog(entries, 'Figma')[0]?.kind).toBe('app')
  expect(searchPackageCatalog(entries, 'libsodium')[0]?.kind).toBe('library')
})

test('catalog refresh preserves errors and validates install identifiers and artwork URLs', async () => {
  await expect(fetchPackageCatalog({ fetch: async () => new Response('unavailable', { status: 503 }) })).rejects.toThrow('503')
  const entry = snapshot.packages[0]!
  expect(() => parsePackageCatalog({ schemaVersion: 1, packages: [{...entry, domain: '--eval'}] })).toThrow('identifier')
  expect(() => parsePackageCatalog({ schemaVersion: 1, packages: [{...entry, domain: 'x/../y'}] })).toThrow('identifier')
  expect(() => parsePackageCatalog({ schemaVersion: 1, packages: [{...entry, homepageUrl: 'javascript:run()'}] })).toThrow('HTTPS')
  expect(() => parsePackageCatalog({ schemaVersion: 1, packages: [entry, entry] })).toThrow('duplicate')
})

test('catalog and desktop transport bundle for browsers without the external installer', async () => {
  for (const entry of ['src/catalog/client.ts', 'src/desktop/client.ts']) {
    const result = await Bun.build({ entrypoints: [new URL('../' + entry, import.meta.url).pathname], target: 'browser' })
    expect(result.success).toBe(true)
    const source = await result.outputs[0]!.text()
    expect(source).not.toContain('Bun.spawn')
    expect(source).not.toContain('node:fs')
    expect(source).not.toContain('startDesktopBridge')
  }
})

test('retained logos match the catalog digest and original source manifest', async () => {
  const logos = (await import('../../../catalog/logos.json')).default
  const { createHash } = await import('node:crypto')
  expect(Object.keys(logos).length).toBeGreaterThan(1100)
  for (const entry of snapshot.packages) {
    if (!entry.logo) continue
    const file = new URL('../../../assets/package-logos/' + entry.logo.url.split('/').pop(), import.meta.url)
    const bytes = await Bun.file(file).arrayBuffer()
    expect(createHash('sha256').update(new Uint8Array(bytes)).digest('hex')).toBe(entry.logo.sha256)
    expect((logos as Record<string, unknown>)[entry.domain]).toEqual(entry.logo)
  }
})
