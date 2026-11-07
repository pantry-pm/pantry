import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isManagedUserPackage, uninstallUserPackage, validManagedDomain } from '../src/desktop/uninstall'
import { PantryDesktopClient } from '../src/desktop/client'
import { startDesktopBridge, createDesktopPairingCode } from '../src/desktop/service'
import { bundledPackageCatalog } from '../src/catalog/client'

function fixture(domain = 'example.org/tool') {
  const root = mkdtempSync(join(tmpdir(), 'pantry-uninstall-'))
  const store = join(root, 'store')
  const home = join(root, 'home')
  const version = join(store, 'packages', domain, 'v1.0.0')
  mkdirSync(join(version, 'bin'), { recursive: true })
  writeFileSync(join(version, 'bin/tool'), 'fixture executable')
  mkdirSync(join(store, 'bin'), { recursive: true })
  symlinkSync(join(version, 'bin/tool'), join(store, 'bin/tool'))
  symlinkSync('v1.0.0', join(store, 'packages', domain, 'v1'))
  return { root, store, home, version, domain, close: () => rmSync(root, { recursive: true, force: true }) }
}
function app(path: string, id = 'test.pantry.fixture') {
  mkdirSync(join(path, 'Contents/MacOS'), { recursive: true })
  writeFileSync(join(path, 'Contents/Info.plist'), `<plist><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`)
  writeFileSync(join(path, 'Contents/MacOS/fixture'), 'test executable')
}

test('uninstall moves only the requested package and its own activations to recoverable Trash', async () => {
  const f = fixture()
  try {
    const dependency = join(f.store, 'packages/other.org/v2.0.0')
    mkdirSync(join(dependency, 'bin'), { recursive: true })
    writeFileSync(join(dependency, 'bin/shared'), 'unrelated dependency')
    symlinkSync(join(dependency, 'bin/shared'), join(f.store, 'bin/shared'))
    writeFileSync(join(f.store, 'bin/foreign'), 'a command Pantry did not create')
    expect(await isManagedUserPackage(f.domain, f)).toBe(true)
    const output: string[] = []
    await uninstallUserPackage(f.domain, f, text => output.push(text))
    expect(await isManagedUserPackage(f.domain, f)).toBe(false)
    expect(existsSync(join(f.store, 'bin/tool'))).toBe(false)
    expect(existsSync(join(f.store, 'packages', f.domain, 'v1'))).toBe(false)
    expect(readFileSync(join(f.store, 'bin/shared'), 'utf8')).toBe('unrelated dependency')
    expect(readFileSync(join(f.store, 'bin/foreign'), 'utf8')).toBe('a command Pantry did not create')
    expect(readdirSync(join(f.home, '.Trash'))).toHaveLength(1)
    expect(output.join('')).toContain('App data and other packages were kept')
  }
  finally { f.close() }
})

test('native app and font assets are removed together while preferences and other versions remain independent', async () => {
  const f = fixture()
  try {
    app(join(f.version, 'Fixture.app'))
    app(join(f.home, 'Applications/Fixture.app'))
    mkdirSync(join(f.home, 'Library/Fonts'), { recursive: true })
    writeFileSync(join(f.version, 'Fixture.ttf'), 'font fixture')
    writeFileSync(join(f.home, 'Library/Fonts/Fixture.ttf'), 'font fixture')
    mkdirSync(join(f.home, 'Library/Application Support/Fixture'), { recursive: true })
    writeFileSync(join(f.home, 'Library/Application Support/Fixture/preferences'), 'kept')
    const previous = join(f.store, 'packages', f.domain, 'v0.9.0')
    mkdirSync(previous, { recursive: true })
    writeFileSync(join(previous, 'Fixture.ttf'), 'older font fixture')
    await uninstallUserPackage(f.domain, f)
    expect(existsSync(join(f.home, 'Applications/Fixture.app'))).toBe(false)
    expect(existsSync(join(f.home, 'Library/Fonts/Fixture.ttf'))).toBe(false)
    expect(existsSync(f.version)).toBe(false)
    expect(existsSync(previous)).toBe(false)
    expect(readFileSync(join(f.home, 'Library/Application Support/Fixture/preferences'), 'utf8')).toBe('kept')
  }
  finally { f.close() }
})

test('foreign replacements fail before any package files move', async () => {
  for (const kind of ['app', 'font', 'symlink']) {
    const f = fixture()
    try {
      if (kind === 'app') { app(join(f.version, 'Fixture.app')); app(join(f.home, 'Applications/Fixture.app'), 'test.foreign.app') }
      else {
        writeFileSync(join(f.version, 'Fixture.ttf'), 'original')
        mkdirSync(join(f.home, 'Library/Fonts'), { recursive: true })
        if (kind === 'font') writeFileSync(join(f.home, 'Library/Fonts/Fixture.ttf'), 'foreign replacement')
        else symlinkSync(join(f.version, 'Fixture.ttf'), join(f.home, 'Library/Fonts/Fixture.ttf'))
      }
      await expect(uninstallUserPackage(f.domain, f)).rejects.toThrow()
      expect(existsSync(f.version)).toBe(true)
      expect(existsSync(join(f.store, 'bin/tool'))).toBe(true)
    }
    finally { f.close() }
  }
})

test('removal refuses traversal, unmanaged packages and escaping storage symlinks', async () => {
  const f = fixture()
  try {
    for (const domain of ['../escape', '/absolute', 'example/../escape', 'x//y', 'x/./y', '-option', 'x;command', '']) {
      expect(validManagedDomain(domain)).toBe(false)
      await expect(uninstallUserPackage(domain, f)).rejects.toThrow()
    }
    await expect(uninstallUserPackage('not-managed.org', f)).rejects.toThrow('not managed')
    const outside = join(f.root, 'outside')
    mkdirSync(join(outside, 'v1'), { recursive: true })
    symlinkSync(outside, join(f.store, 'packages/escape.org'))
    expect(await isManagedUserPackage('escape.org', f)).toBe(false)
    await expect(uninstallUserPackage('escape.org', f)).rejects.toThrow()
    expect(existsSync(outside)).toBe(true)
  }
  finally { f.close() }
})

test('a namespace package cannot remove another nested package', async () => {
  const f = fixture('example.org')
  try {
    const nested = join(f.store, 'packages/example.org/other/v2.0.0')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'keep'), 'kept')
    await uninstallUserPackage(f.domain, f)
    expect(readFileSync(join(nested, 'keep'), 'utf8')).toBe('kept')
  }
  finally { f.close() }
})

test('desktop uninstall is authenticated, client-owned, idempotent and conflicts with install request IDs', async () => {
  const f = fixture('bun.com')
  const directory = join(f.root, 'service')
  const bridge = startDesktopBridge({ stateDirectory: directory, port: 0, removal: f, catalog: bundledPackageCatalog().filter(entry => entry.domain === 'bun.com'), run: async (args, output) => { if (args[0] === 'list') output(JSON.stringify([{ name: f.domain, version: '1.0.0' }])); return 0 } })
  const baseUrl = `http://127.0.0.1:${bridge.server.port}`
  try {
    const anonymous = new PantryDesktopClient({ baseUrl })
    expect((await anonymous.health()).capabilities).toContain('uninstall:user')
    await expect(anonymous.uninstall(f.domain)).rejects.toThrow('Connect')
    const client = new PantryDesktopClient({ baseUrl, token: await anonymous.pair(createDesktopPairingCode(directory), 'First') })
    const second = new PantryDesktopClient({ baseUrl, token: await anonymous.pair(createDesktopPairingCode(directory), 'Second') })
    expect((await client.installed())[0]?.managed).toBe(true)
    const requestId = crypto.randomUUID()
    const job = await client.uninstall(f.domain, requestId)
    expect(job.operation).toBe('uninstall')
    expect((await client.uninstall(f.domain, requestId)).id).toBe(job.id)
    await expect(client.install(f.domain, requestId)).rejects.toThrow('another package or operation')
    await expect(second.job(job.id)).rejects.toThrow('not found')
    for (let index = 0; index < 100 && ['queued', 'running'].includes((await client.job(job.id)).status); index++) await Bun.sleep(5)
    expect((await client.job(job.id)).status).toBe('succeeded')
    expect((await client.installed())[0]?.managed).toBe(false)
    await expect(client.uninstall(f.domain)).rejects.toThrow('not managed')
    await expect(client.uninstall('../escape')).rejects.toThrow('catalog')
    expect((await second.jobs())).toEqual([])
  }
  finally { await bridge.close(); f.close() }
})


test('Pantry forwarding launchers are removed while foreign programs are preserved', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.store, 'bin/wrapper'), `#!/bin/sh\nexec "${f.version}/bin/tool" "definitely not shell"\n`)
    writeFileSync(join(f.store, 'bin/owned'), `#!/bin/sh\nexec bun "${f.version}/bin/tool" 'fixed argument' "$@"\n`)
    await uninstallUserPackage(f.domain, f)
    expect(existsSync(join(f.store, 'bin/owned'))).toBe(false)
    expect(existsSync(join(f.store, 'bin/wrapper'))).toBe(true)
  }
  finally { f.close() }
})

test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('a filesystem failure rolls back completed moves', async () => {
  const f = fixture()
  const parent = join(f.store, 'packages', f.domain)
  try {
    chmodSync(parent, 0o500)
    await expect(uninstallUserPackage(f.domain, f)).rejects.toThrow()
    expect(existsSync(f.version)).toBe(true)
    expect(readFileSync(join(f.store, 'bin/tool'), 'utf8')).toBe('fixture executable')
  }
  finally { chmodSync(parent, 0o700); f.close() }
})

test('the running package-manager executable cannot be removed', async () => {
  const f = fixture()
  try {
    await expect(uninstallUserPackage(f.domain, { ...f, protectedPaths: [join(f.version, 'bin/tool')] })).rejects.toThrow('cannot uninstall itself')
    expect(existsSync(f.version)).toBe(true)
  }
  finally { f.close() }
})


test('running applications must be quit before their files are moved', async () => {
  const f = fixture()
  try {
    app(join(f.version, 'Fixture.app'))
    const installed = join(f.home, 'Applications/Fixture.app')
    app(installed)
    await expect(uninstallUserPackage(f.domain, { ...f, runningExecutables: [join(installed, 'Contents/MacOS/fixture')] })).rejects.toThrow('Quit Fixture')
    expect(existsSync(installed)).toBe(true)
    expect(existsSync(f.version)).toBe(true)
  }
  finally { f.close() }
})
