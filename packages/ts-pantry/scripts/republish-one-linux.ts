#!/usr/bin/env bun
/**
 * One-off: source-build + republish a SINGLE package for ONE linux platform on a
 * throwaway Hetzner box booted from the pantry-build snapshot, then destroy it.
 *
 * Unlike the fleet daemon (which runs --mirror-only and DOWNLOADS from pkgx),
 * this compiles from the recipe (--force, no mirror) so a corrected recipe's
 * binary actually lands in the registry. The box is always destroyed in finally.
 *
 *   bun scripts/republish-one-linux.ts <domain> <platform> [serverType] [location]
 *   bun scripts/republish-one-linux.ts gnu.org/libiconv linux-x86-64
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HetznerClient, resolveHetznerApiToken } from '@stacksjs/ts-cloud'

const [DOMAIN, PLATFORM, SERVER_TYPE = 'cpx41', LOCATION = 'ash'] = process.argv.slice(2)
if (!DOMAIN || !PLATFORM) {
  console.error('usage: republish-one-linux.ts <domain> <platform> [serverType] [location]')
  process.exit(1)
}

const log = (m: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`)

function client(): HetznerClient {
  const f = join(homedir(), '.hcloud-token')
  const tok = existsSync(f) ? readFileSync(f, 'utf8').trim() : undefined
  return new HetznerClient({ apiToken: resolveHetznerApiToken(tok) })
}

const SSH_OPTS = [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=30',
  '-i', join(homedir(), '.ssh', 'id_ed25519'),
]
const ssh = (ip: string, cmd: string) =>
  execFileSync('ssh', [...SSH_OPTS, `root@${ip}`, cmd], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })

async function waitForSsh(ip: string, maxMs = 300000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try { ssh(ip, 'echo ok'); return }
    catch { await Bun.sleep(8000) }
  }
  throw new Error(`${ip}: never reachable over SSH`)
}

async function templateImageId(c: HetznerClient): Promise<number> {
  const tok = (c as any).apiToken || (existsSync(join(homedir(), '.hcloud-token')) ? readFileSync(join(homedir(), '.hcloud-token'), 'utf8').trim() : '')
  const r = await fetch('https://api.hetzner.cloud/v1/images?type=snapshot', { headers: { Authorization: `Bearer ${tok}` } })
  const d: any = await r.json()
  const imgs = (d.images || []).filter((i: any) => i.labels?.role === 'pantry-build' || /pantry-build-worker/.test(i.description || ''))
  const ready = imgs.filter((i: any) => i.status === 'available').sort((a: any, b: any) => (b.created || '').localeCompare(a.created || ''))
  if (!ready.length) throw new Error('no pantry-build snapshot image found')
  return ready[0].id
}

async function sshKeyId(c: HetznerClient): Promise<number> {
  const pub = join(homedir(), '.ssh', 'id_ed25519.pub')
  const body = readFileSync(pub, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
  const keys = await c.listSshKeys()
  const match = keys.find(k => k.public_key.split(/\s+/).slice(0, 2).join(' ') === body)
  if (!match) throw new Error('local SSH key not registered in this Hetzner project')
  return match.id
}

const c = client()
const imageId = await templateImageId(c)
const keyId = await sshKeyId(c)
const name = `pantry-republish-${Date.now().toString(36)}`
log(`booting ${name} (${SERVER_TYPE} @ ${LOCATION}) from snapshot ${imageId} for ${DOMAIN} ${PLATFORM}`)

let serverId: number | undefined
try {
  const { server } = await c.createServer({
    name,
    serverType: SERVER_TYPE,
    image: String(imageId) as any,
    location: LOCATION,
    sshKeys: [keyId],
    labels: { purpose: 'pantry-republish-oneoff', platform: PLATFORM },
  })
  serverId = server.id
  const running = await c.waitForServerRunning(server.id)
  const ip = running.public_net?.ipv4?.ip
  if (!ip) throw new Error('running but no public IPv4')
  log(`  created (${ip}) — waiting for ssh…`)
  await waitForSsh(ip)

  const build = [
    'set -euo pipefail',
    'export PATH=/root/.bun/bin:/root/.cargo/bin:/usr/local/go/bin:$PATH',
    'git -C /root/pantry fetch origin main -q && git -C /root/pantry reset --hard origin/main -q',
    'bun install --cwd /root/pantry >/dev/null 2>&1 || true',
    'cd /root/pantry/packages/ts-pantry',
    'set -a; source /root/.pantry-hetzner.env; set +a',
    `bun scripts/build-all-packages.ts -b "$S3_BUCKET" -r "$S3_REGION" --platform ${PLATFORM} -p ${DOMAIN} --force`,
  ].join(' && ')

  log(`  building ${DOMAIN} for ${PLATFORM} (source build → upload)…`)
  const out = ssh(ip, build)
  process.stdout.write(out.split('\n').slice(-40).join('\n') + '\n')
  log('✓ build + upload finished')
}
finally {
  if (serverId !== undefined) {
    log(`destroying box ${serverId}…`)
    try { await c.deleteServer(serverId); log('✓ box destroyed') }
    catch (e) { log(`⚠️  FAILED to destroy box ${serverId}: ${(e as Error).message} — destroy it manually!`) }
  }
}
