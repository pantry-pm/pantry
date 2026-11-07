import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const binary = process.env.PANTRY_SOURCE_CLI
// Real catalog edge, native source CLI, private filesystem caches and actual
// HTTP metadata. These are library interface fixtures, not SDK artifacts.
describe.skipIf(!binary)('native dependency readiness with a warm global source', () => {
  test('materializes a warm transitive library in the requested project before success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry-native-warm-dependency-'))
    const home = join(root, 'home')
    const data = join(root, 'data')
    const local = join(root, 'local-app-data')
    const global = process.platform === 'darwin' ? join(home, '.local/share/pantry/global') : process.platform === 'win32' ? join(local, 'pantry/data/global') : join(data, 'pantry/global')
    const domains = ['zlib.net/minizip', 'zlib.net']
    const version = '1.3.1'
    const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'x86-64' : process.arch}`
    const paths: string[] = []
    let child: ReturnType<typeof Bun.spawn> | undefined
    let server: ReturnType<typeof Bun.serve> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let passed = false
    try {
      mkdirSync(home)
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'native-warm-dependency-fixture', private: true }))
      for (const domain of domains) {
        const share = join(global, 'packages', domain, `v${version}`, 'share')
        mkdirSync(share, { recursive: true })
        writeFileSync(join(share, 'owner.txt'), `${domain}@${version} fixture\n`)
      }
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        const path = new URL(request.url).pathname
        paths.push(path)
        for (const domain of domains) {
          if (path === `/binaries/${domain}/metadata.json`) return Response.json({ versions: { [version]: { platforms: { [platform]: { tarball: `binaries/${domain}/${version}/${platform}/fixture.tar.gz`, sha256: '0'.repeat(64), size: 1 } } } } })
        }
        return new Response('unexpected fixture request', { status: 404 })
      } })
      const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: local, XDG_DATA_HOME: data, XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'), PANTRY_ENV_DEPS: '0', PANTRY_REGISTRY_ACCELERATION: '0', PANTRY_REGISTRY_URL: `http://127.0.0.1:${server.port}`, PANTRY_REGISTRY_TOKEN: '' }
      child = Bun.spawn({ cmd: [binary!, 'install', `${domains[0]}@${version}`, '--no-save', '--ignore-scripts', '--quiet'], cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
      let expired = false
      timer = setTimeout(() => { expired = true; child?.kill() }, 30_000)
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      clearTimeout(timer)
      timer = undefined
      writeFileSync(join(root, 'result.json'), JSON.stringify({ expired, code, paths, inventory: domains.map(domain => ({ domain, global: existsSync(join(global, 'packages', domain, `v${version}/share/owner.txt`)), project: existsSync(join(root, 'pantry', domain, `v${version}/share/owner.txt`)) })) }))
      writeFileSync(join(root, 'stdout'), stdout)
      writeFileSync(join(root, 'stderr'), stderr)
      expect(expired, stdout + stderr).toBe(false)
      expect(code, stdout + stderr).toBe(0)
      expect(stdout + stderr).not.toContain('error(DebugAllocator)')
      for (const domain of domains) {
        expect(readFileSync(join(root, 'pantry', domain, `v${version}/share/owner.txt`), 'utf8')).toBe(`${domain}@${version} fixture\n`)
        expect(readFileSync(join(global, 'packages', domain, `v${version}/share/owner.txt`), 'utf8')).toBe(`${domain}@${version} fixture\n`)
      }
      expect(paths.some(path => path.endsWith('fixture.tar.gz'))).toBe(false)
      expect(existsSync(join(root, 'pantry.lock'))).toBe(false)
      passed = true
    }
    finally {
      if (timer) clearTimeout(timer)
      if (child) { try { child.kill() } catch {} await child.exited }
      await server?.stop(true)
      if (passed) rmSync(root, { recursive: true, force: true })
      else console.error(`Retained native warm dependency fixture: ${root}`)
    }
  }, 60_000)
})
