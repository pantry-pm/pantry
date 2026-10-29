import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledPackageCatalog } from '../src/catalog/client'
import { PantryDesktopClient } from '../src/desktop/client'
import { createDesktopPairingCode, startDesktopBridge } from '../src/desktop/service'

test('desktop bridge pairs once, authenticates, constrains install arguments and deduplicates retries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-desktop-'))
  const calls: string[][] = []
  let release: (() => void) | undefined
  const bridge = startDesktopBridge({ stateDirectory: directory, port: 0, run: async (args, output) => {
    calls.push(args)
    if (args[0] === 'list') { output(JSON.stringify([{ name: 'bun.com', version: '1.4.4' }])); return 0 }
    output('Installing from the Pantry registry\n')
    await new Promise<void>(resolve => { release = resolve })
    return 0
  } })
  const baseUrl = `http://127.0.0.1:${bridge.server.port}`
  try {
    const anonymous = new PantryDesktopClient({ baseUrl })
    expect((await anonymous.health()).protocolVersion).toBe(1)
    await expect(anonymous.installed()).rejects.toThrow('Connect')
    const code = createDesktopPairingCode(directory)
    const token = await anonymous.pair(code, 'Launchpad')
    await expect(anonymous.pair(code, 'Other client')).rejects.toThrow('expired')
    const client = new PantryDesktopClient({ baseUrl, token })
    expect(await client.installed()).toEqual([{ name: 'bun.com', version: '1.4.4' }])
    const requestId = crypto.randomUUID()
    const job = await client.install('bun.com', requestId)
    expect((await client.install('bun.com', requestId)).id).toBe(job.id)
    await expect(client.install('git-scm.org', requestId)).rejects.toThrow('another package')
    await expect(client.install('bun.com;touch /tmp/injected')).rejects.toThrow('catalog')
    expect(calls.filter(args => args[0] === 'install')).toEqual([['install', '--user', 'bun.com']])
    release!()
    for (let i = 0; i < 50 && (await client.job(job.id)).status !== 'succeeded'; i++) await Bun.sleep(5)
    expect((await client.job(job.id)).status).toBe('succeeded')
    expect((await client.jobs())[0]?.id).toBe(job.id)
    expect((await fetch(baseUrl + '/v1/installed', { headers: { origin: 'https://attacker.example', authorization: 'Bearer ' + token } })).status).toBe(403)
    expect((await fetch(baseUrl + '/health', { headers: { host: 'attacker.example' } })).status).toBe(403)
    expect(readFileSync(join(directory, 'state.json'), 'utf8')).not.toContain(token)
    await client.disconnect()
    await expect(client.installed()).rejects.toThrow('Connect')
  }
  finally { release?.(); await bridge.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('pairing expires and install jobs are isolated between connected apps', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-desktop-'))
  let now = Date.now()
  const catalog = bundledPackageCatalog().filter(entry => entry.domain === 'bun.com')
  const bridge = startDesktopBridge({ stateDirectory: directory, port: 0, now: () => now, catalog, run: async () => 7 })
  const baseUrl = `http://127.0.0.1:${bridge.server.port}`
  try {
    const client = new PantryDesktopClient({ baseUrl })
    const expired = createDesktopPairingCode(directory, now)
    now += 300001
    await expect(client.pair(expired, 'Launchpad')).rejects.toThrow('expired')
    const first = new PantryDesktopClient({baseUrl, token: await client.pair(createDesktopPairingCode(directory, now), 'First')})
    const second = new PantryDesktopClient({baseUrl, token: await client.pair(createDesktopPairingCode(directory, now), 'Second')})
    const job = await first.install('bun.com')
    expect(await second.jobs()).toEqual([])
    expect((await first.jobs())[0]?.id).toBe(job.id)
    await expect(second.job(job.id)).rejects.toThrow('not found')
    expect((await first.job(job.id)).status).toBe('failed')
    await expect(first.install('unknown.example')).rejects.toThrow('catalog')
  }
  finally { await bridge.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('desktop clients reject non-loopback brokers', () => {
  expect(() => new PantryDesktopClient({baseUrl: 'http://example.com'})).toThrow('loopback')
  expect(() => new PantryDesktopClient({baseUrl: 'http://127.0.0.1.evil.example'})).toThrow('loopback')
})

test('app and font installations use the native CLI activation path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-desktop-kinds-'))
  const calls: string[][] = []
  const bridge = startDesktopBridge({ stateDirectory: directory, port: 0, run: async args => { calls.push(args); return 0 } })
  try {
    const baseUrl = `http://127.0.0.1:${bridge.server.port}`
    const token = await new PantryDesktopClient({ baseUrl }).pair(createDesktopPairingCode(directory), 'Launchpad')
    const client = new PantryDesktopClient({ baseUrl, token })
    for (const domain of ['figma.com', 'inter']) {
      const job = await client.install(domain)
      for (let index = 0; index < 20 && (await client.job(job.id)).status !== 'succeeded'; index++) await Bun.sleep(5)
      expect((await client.job(job.id)).status).toBe('succeeded')
    }
    expect(calls).toEqual([['install', '--user', '--kind', 'app', 'figma.com'], ['install', '--user', '--kind', 'font', 'inter']])
  }
  finally { await bridge.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('install receipts expose the authoritative package kind and execution timestamps', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-desktop-receipts-'))
  const catalog = ['app', 'cli', 'library', 'font'].map(kind => bundledPackageCatalog().find(entry => entry.kind === kind)!)
  let now = Date.parse('2026-10-27T12:00:00Z')
  const bridge = startDesktopBridge({ stateDirectory: directory, port: 0, catalog, now: () => now, run: async () => { now += 2000; return 0 } })
  try {
    const baseUrl = `http://127.0.0.1:${bridge.server.port}`
    const token = await new PantryDesktopClient({ baseUrl }).pair(createDesktopPairingCode(directory, now), 'Launchpad')
    const client = new PantryDesktopClient({ baseUrl, token })
    for (const entry of catalog) {
      const job = await client.install(entry.domain)
      for (let index = 0; index < 50 && (await client.job(job.id)).status !== 'succeeded'; index++) await Bun.sleep(5)
      const receipt = await client.job(job.id)
      expect(receipt.kind).toBe(entry.kind)
      expect(Date.parse(receipt.finishedAt!) - Date.parse(receipt.startedAt!)).toBe(2000)
      expect(receipt.timezoneOffset).toBe(new Date(now).getTimezoneOffset())
      expect((await client.jobs()).find(item => item.id === job.id)).toEqual(receipt)
    }
  }
  finally { await bridge.close(); rmSync(directory, { recursive: true, force: true }) }
})
