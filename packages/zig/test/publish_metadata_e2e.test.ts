/**
 * `pantry publish` packs a package without the publishing machine's file
 * metadata.
 *
 * macOS tar writes an AppleDouble `._name` entry beside every file that carries
 * extended attributes (com.apple.provenance is on any file a sandboxed app
 * wrote). macOS's own tar hides them when listing, so they went unnoticed until
 * a kit published from a Mac unpacked on Linux with thousands of `._*` files and
 * a migration runner tried to execute `._0000000001-create-database-types.sql`.
 *
 * Runs the built binary against a local stand-in registry and reads the
 * uploaded tarball's members directly (not through macOS tar).
 */
import { afterAll, beforeAll, expect, it, setDefaultTimeout } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

setDefaultTimeout(60_000)

const PANTRY_BIN = process.env.PANTRY_E2E_BIN || resolve(dirname(import.meta.dir), 'zig-out/bin/pantry')
let server: ReturnType<typeof Bun.serve> | undefined
let uploaded: Uint8Array | null = null
let dir = ''

/** Member names of a gzipped tar, read from the headers themselves. */
function members(tgz: Uint8Array): string[] {
  const tar = gunzipSync(tgz)
  const names: string[] = []
  let longName: string | null = null
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start: number, length: number) => new TextDecoder().decode(header.subarray(start, start + length)).replace(/\0.*$/s, '')
    const size = Number.parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    const body = tar.subarray(at + 512, at + 512 + size)
    if (type === 'x') {
      const path = /\d+ path=([^\n]+)\n/.exec(new TextDecoder().decode(body))
      if (path) longName = path[1]!
    }
    else if (type === 'L') {
      longName = new TextDecoder().decode(body).replace(/\0.*$/s, '')
    }
    else if (type !== 'g') {
      const prefix = field(345, 155)
      names.push(longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)))
      longName = null
    }
    at += 512 + Math.ceil(size / 512) * 512
  }
  return names
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pantry-publish-metadata-'))
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname === '/publish') {
        const form = await req.formData()
        for (const value of form.values()) {
          if (value instanceof Blob) uploaded = new Uint8Array(await value.arrayBuffer())
        }
        return Response.json({ success: true, message: 'Published', visibility: 'public' }, { status: 201 })
      }
      return Response.json({ versions: [] })
    },
  })
})

afterAll(() => {
  server?.stop(true)
  if (dir) rmSync(dir, { recursive: true, force: true })
})

it.skipIf(process.platform !== 'darwin' || !existsSync(PANTRY_BIN))('leaves macOS metadata out of a published tarball', async () => {
  const pkg = join(dir, 'pkg')
  mkdirSync(join(pkg, 'source'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'metadata-probe', version: '1.0.0', files: ['source'] }))
  writeFileSync(join(pkg, 'source', 'migration.sql'), 'select 1;\n')
  for (const file of [join(pkg, 'package.json'), join(pkg, 'source'), join(pkg, 'source', 'migration.sql')])
    expect(spawnSync('xattr', ['-w', 'com.example.probe', 'yes', file]).status).toBe(0)

  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const base = `http://127.0.0.1:${server!.port}`
  // Async: the stand-in registry answers from this same event loop.
  const run = Bun.spawn([PANTRY_BIN, 'publish', '--registry', base], {
    cwd: pkg,
    env: { ...process.env, HOME: home, PANTRY_REGISTRY_URL: base, PANTRY_REGISTRY_TOKEN: 'ptry_metadata_probe' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = await new Response(run.stdout).text() + await new Response(run.stderr).text()
  expect(await run.exited, output).toBe(0)
  expect(uploaded).not.toBeNull()

  const names = members(uploaded!)
  expect(names).toContain('package/source/migration.sql')
  expect(names.filter(name => name.split('/').some(part => part.startsWith('._')))).toEqual([])
  expect(readFileSync(join(pkg, 'source', 'migration.sql'), 'utf8')).toBe('select 1;\n')
})
