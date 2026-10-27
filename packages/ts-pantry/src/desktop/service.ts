import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { scanInstalledApps } from '../desktop-apps'
import { bundledPackageCatalog } from '../catalog/client'
import type { PackageCatalogEntry } from '../catalog/types'
import type { DesktopInstallJob, DesktopInstalledPackage } from './client'

export interface DesktopBridgeOptions {
  stateDirectory?: string
  pantryExecutable?: string
  port?: number
  /** Injectable catalog and runner allow real HTTP tests without installing user software. */
  catalog?: readonly PackageCatalogEntry[]
  run?: (args: string[], output: (text: string) => void) => Promise<number>
  now?: () => number
}
interface Client { id: string, name: string, tokenHash: string }
interface StoredJob extends DesktopInstallJob { clientId: string }
interface State { clients: Client[], jobs: StoredJob[] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function desktopStateDirectory(): string { return join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'pantry/desktop') }

export function secureDesktopDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (info.isSymbolicLink() || !info.isDirectory() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error('Pantry Desktop state must be an owner-only directory')
}
function readPrivate(file: string): unknown {
  const info = lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 40000000 || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error('Pantry Desktop state must be an owner-only file')
  return JSON.parse(readFileSync(file, 'utf8'))
}
function writePrivate(file: string, value: unknown) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, file)
  chmodSync(file, 0o600)
}

/** Local terminal approval creates a short-lived, single-use pairing code. */
export function createDesktopPairingCode(stateDirectory: string = desktopStateDirectory(), now: number = Date.now()): string {
  secureDesktopDirectory(stateDirectory)
  const code = String(randomInt(10000000, 100000000))
  writePrivate(join(stateDirectory, 'pairing.json'), { hash: hash(code), expiresAt: now + 300000 })
  return code
}

function equalHash(a: string, b: string) { return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')) }
function publicJob(job: StoredJob): DesktopInstallJob {
  const { clientId, ...result } = job
  void clientId
  return result
}

/** Application discovery belongs to the external process, including the real user Applications directory. */
export function installedCatalogApplications(catalog: readonly PackageCatalogEntry[]): DesktopInstalledPackage[] {
  if (process.platform !== 'darwin') return []
  const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')
  const byName = new Map(catalog.filter(entry => entry.kind === 'app').map(entry => [normalize(entry.name), entry.domain]))
  return ['/Applications', join(homedir(), 'Applications')].flatMap(root => scanInstalledApps(root)).flatMap(app => {
    const domain = byName.get(normalize(app.name))
    return domain ? [{ name: domain, version: app.version, applicationPath: app.path }] : []
  })
}

/** Standalone Pantry process. The launcher never spawns or embeds an installer. */
export interface DesktopBridge { server: Bun.Server<undefined>, close: () => Promise<void> }

export function startDesktopBridge(options: DesktopBridgeOptions = {}): DesktopBridge {
  const directory = options.stateDirectory ?? desktopStateDirectory()
  secureDesktopDirectory(directory)
  const stateFile = join(directory, 'state.json')
  const state = (existsSync(stateFile) ? readPrivate(stateFile) : { clients: [], jobs: [] }) as State
  if (!Array.isArray(state.clients) || !Array.isArray(state.jobs)) throw new Error('Invalid Pantry Desktop state')
  const persist = () => writePrivate(stateFile, state)
  for (const job of state.jobs) {
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'failed'
      job.error = 'Pantry restarted before this installation completed. Check installed packages before retrying.'
      job.finishedAt = new Date().toISOString()
    }
  }
  persist()
  const catalog = options.catalog ?? bundledPackageCatalog()
  const packages = new Map(catalog.map(entry => [entry.domain, entry]))
  const executable = options.pantryExecutable ?? Bun.which('pantry')
  if (!options.run && (!executable || !isAbsolute(executable))) throw new Error('Install the Pantry CLI before starting its desktop bridge')
  const now = options.now ?? Date.now
  let activeChild: ReturnType<typeof Bun.spawn> | undefined
  const execute = options.run ?? (async (args: string[], output: (text: string) => void) => {
    const child = Bun.spawn([executable!, ...args], { cwd: directory, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1', CI: '1' } })
    activeChild = child
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          output(decoder.decode(chunk.value, { stream: true }))
        }
      }
      finally { reader.releaseLock() }
    }
    try {
      await Promise.all([consume(child.stdout), consume(child.stderr)])
      return await child.exited
    }
    finally { activeChild = undefined }
  })
  let commandTail: Promise<unknown> = Promise.resolve()
  const run = (args: string[], output: (text: string) => void): Promise<number> => {
    const task = commandTail.then(() => {
      if (closing) throw new Error('Pantry Desktop is stopping')
      return execute(args, output)
    })
    commandTail = task.catch(() => {})
    return task
  }
  let running = false
  let closing = false
  let drainTask: Promise<void> | undefined
  async function drain() {
    if (running || closing) return
    running = true
    try {
      while (!closing) {
        const job = state.jobs.find(item => item.status === 'queued')
        if (!job) break
        job.status = 'running'
        persist()
        try {
          const kind = packages.get(job.domain)!.kind
          const exitCode = await run(['install', '--user', ...(['app', 'font'].includes(kind) ? ['--kind', kind] : []), job.domain], (text) => { job.output = (job.output + text).slice(-32000) })
          job.status = exitCode === 0 ? 'succeeded' : 'failed'
          if (exitCode) job.error = `Pantry installation exited with code ${exitCode}`
        }
        catch (error) {
          job.status = 'failed'
          job.error = error instanceof Error ? error.message : 'Pantry installation failed'
        }
        job.finishedAt = new Date(now()).toISOString()
        persist()
      }
    }
    finally { running = false }
  }
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  const attempts: number[] = []
  const server: Bun.Server<undefined> = Bun.serve({
    hostname: '127.0.0.1', port: options.port ?? 46473, maxRequestBodySize: 4096,
    async fetch(request) {
      const url = new URL(request.url)
      // No browser origins, wildcard CORS or DNS-based hostnames are accepted.
      if (request.headers.has('origin') || request.headers.get('host') !== `127.0.0.1:${server.port}`) return respond({ error: 'Forbidden origin or host' }, 403)
      if (url.pathname === '/health' && request.method === 'GET') return respond({ protocolVersion: 1, service: 'pantry-desktop', capabilities: ['install:user', 'installed', 'jobs'] })
      if (url.pathname === '/pair' && request.method === 'POST') {
        while (attempts.length && attempts[0]! < now() - 60000) attempts.shift()
        if (attempts.length >= 10) return respond({ error: 'Too many pairing attempts. Try again in a minute.' }, 429)
        attempts.push(now())
        const body = await request.json().catch(() => null) as { code?: unknown, name?: unknown } | null
        if (!body || typeof body.code !== 'string' || !/^\d{8}$/.test(body.code) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) return respond({ error: 'Provide the pairing code and application name.' }, 422)
        const file = join(directory, 'pairing.json')
        if (!existsSync(file)) return respond({ error: 'Create a pairing code from the Pantry CLI first.' }, 401)
        const pairing = readPrivate(file) as { hash: string, expiresAt: number }
        if (pairing.expiresAt <= now() || !equalHash(pairing.hash, hash(body.code))) return respond({ error: 'The Pantry pairing code is invalid or expired.' }, 401)
        if (state.clients.length >= 100) return respond({ error: 'Remove unused Pantry Desktop connections before pairing another app.' }, 409)
        const token = randomBytes(32).toString('base64url')
        state.clients.push({ id: crypto.randomUUID(), name: body.name.trim(), tokenHash: hash(token) })
        writePrivate(file, { hash: '', expiresAt: 0 })
        persist()
        return respond({ token }, 201)
      }
      const auth = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
      const client = auth ? state.clients.find(item => equalHash(item.tokenHash, hash(auth))) : undefined
      if (!client) return respond({ error: 'Connect this application to Pantry first.' }, 401)
      if (url.pathname === '/v1/connection' && request.method === 'DELETE') {
        state.clients = state.clients.filter(item => item.id !== client.id)
        persist()
        return respond({ disconnected: true })
      }
      if (url.pathname === '/v1/installed' && request.method === 'GET') {
        let output = ''
        const code = await run(['list', '--format', 'json'], text => { if (output.length < 4000000) output += text })
        if (code) return respond({ error: 'Pantry could not list installed packages.' }, 502)
        try {
          const installed = JSON.parse(output) as DesktopInstalledPackage[]
          if (!Array.isArray(installed) || installed.some(item => typeof item.name !== 'string' || typeof item.version !== 'string')) throw new Error('Invalid installed package list')
          return respond({ packages: [...installed.map(item => ({ name: item.name, version: item.version })), ...(options.run ? [] : installedCatalogApplications(catalog))] })
        }
        catch { return respond({ error: 'Pantry returned an invalid installed package list.' }, 502) }
      }
      if (url.pathname === '/v1/install' && request.method === 'POST') {
        const body = await request.json().catch(() => null) as { domain?: unknown, requestId?: unknown } | null
        if (!body || typeof body.domain !== 'string' || !packages.has(body.domain) || typeof body.requestId !== 'string' || !uuid.test(body.requestId)) return respond({ error: 'Choose a package from the Pantry catalog and provide a request ID.' }, 422)
        const previous = state.jobs.find(job => job.clientId === client.id && job.requestId === body.requestId)
        if (previous) return previous.domain === body.domain ? respond({ job: publicJob(previous) }, 202) : respond({ error: 'This request ID already belongs to another package.' }, 409)
        if (state.jobs.filter(job => job.status === 'queued' || job.status === 'running').length >= 3) return respond({ error: 'Wait for current Pantry installations to finish.' }, 429)
        const job: StoredJob = { id: crypto.randomUUID(), requestId: body.requestId, clientId: client.id, domain: body.domain, status: 'queued', output: '', createdAt: new Date(now()).toISOString() }
        state.jobs.push(job)
        if (state.jobs.length > 1000) state.jobs.splice(0, state.jobs.length - 1000)
        persist()
        if (!running) {
          drainTask = drain()
          void drainTask
        }
        return respond({ job: publicJob(job) }, 202)
      }
      if (url.pathname === '/v1/jobs' && request.method === 'GET') return respond({ jobs: state.jobs.filter(job => job.clientId === client.id).slice(-50).reverse().map(publicJob) })
      const match = url.pathname.match(/^\/v1\/jobs\/([a-f0-9-]{36})$/i)
      if (match && request.method === 'GET') {
        const job = state.jobs.find(item => item.id === match[1] && item.clientId === client.id)
        return job ? respond({ job: publicJob(job) }) : respond({ error: 'Pantry installation was not found.' }, 404)
      }
      return respond({ error: 'Not found' }, 404)
    },
    error() { return respond({ error: 'Pantry Desktop could not complete this request.' }, 500) },
  })
  return { server, async close() {
    closing = true
    activeChild?.kill()
    await drainTask
    await commandTail
    await server.stop(true)
  } }
}
