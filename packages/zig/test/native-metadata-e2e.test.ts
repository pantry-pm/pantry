import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const binary = process.env.PANTRY_SOURCE_CLI
const domains = ['first.pantry-fixture.test', 'second.pantry-fixture.test']

// These controlled HTTP cases exercise the actual native CLI and its normal
// custom-registry resolver. They complement the separate public cold-install
// regression; fixture packages make no released-artifact or engine claims.
describe.skipIf(!binary)('source CLI native metadata lifetime over HTTP', () => {
  for (const unavailable of [false, true]) {
    test(unavailable ? 'settles failed metadata before any native payload' : 'resolves independent metadata together and reuses each artifact URL', async () => {
      const root = mkdtempSync(join(tmpdir(), 'pantry-native-http-'))
      let passed = false
      const requests: string[] = []
      const arrivals = new Set<string>()
      let release!: () => void
      const bothArrived = new Promise<void>((resolve) => { release = resolve })
      let server: ReturnType<typeof Bun.serve> | undefined
      let child: ReturnType<typeof Bun.spawn> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let expired = false
      try {
        const stage = join(root, 'stage')
        mkdirSync(join(stage, 'share'), { recursive: true })
        const payload = 'Pantry native HTTP integration fixture\n'
        writeFileSync(join(stage, 'share/native-http-fixture.txt'), payload)
        const archivePath = join(root, 'fixture.tar.gz')
        const tar = spawnSync('tar', ['-czf', archivePath, '-C', stage, 'share'], { encoding: 'utf8', timeout: 5000 })
        expect(tar.error).toBeUndefined()
        expect(tar.status, tar.stderr).toBe(0)
        const archive = readFileSync(archivePath)
        const digest = new Bun.CryptoHasher('sha256').update(archive).digest('hex')
        const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'x86-64' : process.arch}`
        server = Bun.serve({
          hostname: '127.0.0.1', port: 0,
          async fetch(request) {
            const path = new URL(request.url).pathname
            requests.push(path)
            for (const domain of domains) {
              if (path === `/binaries/${domain}/metadata.json`) {
                arrivals.add(domain)
                if (arrivals.size === domains.length) release()
                // Releasing only after both real requests arrive makes serial
                // metadata resolution fail at the unchanged CLI deadline.
                await bothArrived
                if (unavailable && domain === domains[1]) return new Response('fixture unavailable', { status: 503 })
                return Response.json({ versions: { '1.0.0': { platforms: { [platform]: {
                  tarball: `binaries/${domain}/1.0.0/${platform}/fixture.tar.gz`, sha256: digest, size: archive.length,
                } } } } })
              }
              if (path === `/binaries/${domain}/1.0.0/${platform}/fixture.tar.gz`) {
                return new Response(archive, { headers: { 'Content-Length': String(archive.length) } })
              }
            }
            return new Response('unexpected fixture request', { status: 404 })
          },
        })
        mkdirSync(join(root, 'home'))
        // An actual workspace routes the companion roots through the native
        // pipeline without asking a second package manager to resolve them.
        mkdirSync(join(root, 'packages/local'), { recursive: true })
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'native-http-fixture', private: true, workspaces: ['packages/*'], dependencies: { '@pantry-fixture/local': 'workspace:*' } }))
        writeFileSync(join(root, 'packages/local/package.json'), JSON.stringify({ name: '@pantry-fixture/local', version: '1.0.0', private: true }))
        writeFileSync(join(root, 'deps.yaml'), `dependencies:\n${domains.map(domain => `  ${domain}: ^1`).join('\n')}\n`)
        const env = {
          ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), LOCALAPPDATA: join(root, 'local-app-data'), PANTRY_ENV_DEPS: '0', PANTRY_REGISTRY_ACCELERATION: '0',
          PANTRY_REGISTRY_URL: `http://127.0.0.1:${server.port}`, PANTRY_REGISTRY_TOKEN: '',
          XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'),
        }
        const subprocess = Bun.spawn({ cmd: [binary!, 'install', '--ignore-scripts', '--quiet'], cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
        child = subprocess
        timer = setTimeout(() => { expired = true; child?.kill() }, 30_000)
        const [stdout, stderr, code] = await Promise.all([
          new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited,
        ])
        clearTimeout(timer)
        writeFileSync(join(root, 'cli.stdout'), stdout)
        writeFileSync(join(root, 'cli.stderr'), stderr)
        const receipt = { code, expired, unavailable, requests, arrivals: [...arrivals], archiveSHA256: digest, sourceCLISHA256: new Bun.CryptoHasher('sha256').update(readFileSync(binary!)).digest('hex') }
        writeFileSync(join(root, 'result.json'), JSON.stringify(receipt))
        console.log(JSON.stringify({ nativeHTTPFixture: receipt }))
        expect(expired, stdout + stderr).toBe(false)
        expect(arrivals.size).toBe(2)
        const payloadRequests = requests.filter(path => path.endsWith('.tar.gz'))
        if (unavailable) {
          expect(code, stdout + stderr).not.toBe(0)
          expect(stdout + stderr).toContain('RegistryUnavailable')
          expect(payloadRequests).toEqual([])
          for (const domain of domains) expect(existsSync(join(root, 'pantry', domain, 'v1.0.0'))).toBe(false)
        }
        else {
          expect(code, stdout + stderr).toBe(0)
          const lock = JSON.parse(readFileSync(join(root, 'pantry.lock'), 'utf8'))
          writeFileSync(join(root, 'generated-lock.json'), JSON.stringify(lock))
          for (const domain of domains) {
            expect(requests.filter(path => path === `/binaries/${domain}/metadata.json`)).toHaveLength(1)
            expect(payloadRequests.filter(path => path.includes(`/${domain}/`))).toHaveLength(1)
            expect(readFileSync(join(root, 'pantry', domain, 'v1.0.0/share/native-http-fixture.txt'), 'utf8')).toBe(payload)
            expect(lock.packages[`${domain}@1.0.0`]).toEqual({ name: domain, version: '1.0.0', source: 'pantry', resolved: `registry:${domain}@1.0.0` })
          }
        }
        expect(stdout + stderr).not.toContain('error(DebugAllocator)')
        passed = true
      }
      finally {
        if (timer) clearTimeout(timer)
        release()
        if (child && child.exitCode === null) {
          child.kill()
          await child.exited
        }
        await server?.stop(true)
        if (passed) rmSync(root, { recursive: true, force: true })
        else console.error(`Native HTTP fixture evidence retained: ${root}`)
      }
    }, 60_000)
  }
})

describe.skipIf(!binary)('source CLI companion preflight failures', () => {
  test('reports an unreadable companion and releases lookup ownership before workspace work', () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry-companion-preflight-'))
    let passed = false
    try {
      mkdirSync(join(root, 'packages/local'), { recursive: true })
      mkdirSync(join(root, 'home'))
      mkdirSync(join(root, 'deps.yaml'))
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'companion-preflight-fixture', private: true, workspaces: ['packages/*'] }))
      writeFileSync(join(root, 'packages/local/package.json'), JSON.stringify({ name: '@pantry-fixture/preflight', version: '1.0.0', private: true }))
      const env = {
        ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), LOCALAPPDATA: join(root, 'local-app-data'),
        XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'), PANTRY_ENV_DEPS: '0',
      }
      for (const force of [false, true]) {
        const args = ['install', '--ignore-scripts', '--quiet', ...(force ? ['--force'] : [])]
        const result = spawnSync(binary!, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
        const label = force ? 'force' : 'normal'
        writeFileSync(join(root, `${label}.stdout`), result.stdout ?? '')
        writeFileSync(join(root, `${label}.stderr`), result.stderr ?? '')
        writeFileSync(join(root, `${label}.result.json`), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }))
        const output = (result.stdout ?? '') + (result.stderr ?? '')
        expect(result.error).toBeUndefined()
        expect(result.signal).toBeNull()
        expect(result.status, output).toBe(1)
        expect(output).toContain('Error installing deps.yaml:')
        expect(output).not.toContain('error(DebugAllocator)')
        expect(existsSync(join(root, 'pantry.lock'))).toBe(false)
      }
      passed = true
    }
    finally {
      if (passed) rmSync(root, { recursive: true, force: true })
      else console.error(`Companion preflight evidence retained: ${root}`)
    }
  }, 60_000)
})
