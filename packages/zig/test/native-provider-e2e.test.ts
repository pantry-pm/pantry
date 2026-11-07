import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const binary = process.env.PANTRY_SOURCE_CLI

describe.skipIf(!binary)('source CLI authored provider ownership', () => {
  for (const force of [false, true]) {
    test(`preserves an evaluated member npm owner before native metadata${force ? ' with force' : ''}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'pantry-provider-owner-'))
      const requests: string[] = []
      let server: ReturnType<typeof Bun.serve> | undefined
      let child: ReturnType<typeof Bun.spawn> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let expired = false
      let passed = false
      try {
        mkdirSync(join(root, 'packages/typed/config'), { recursive: true })
        mkdirSync(join(root, 'home'))
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'provider-owner-fixture', private: true }))
        writeFileSync(join(root, 'pantry.json'), JSON.stringify({ workspaces: ['packages/*'] }))
        writeFileSync(join(root, 'packages/typed/config/deps.ts'), "export default { dependencies: { 'bun.com': { version: '1.4.3', source: 'npm' } } }\n")
        server = Bun.serve({
          hostname: '127.0.0.1', port: 0,
          fetch(request) {
            requests.push(new URL(request.url).pathname)
            return new Response('metadata must not start before ownership validation', { status: 503 })
          },
        })
        const env = {
          ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), LOCALAPPDATA: join(root, 'local-app-data'),
          XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'),
          PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
          PANTRY_ENV_DEPS: '0', PANTRY_REGISTRY_ACCELERATION: '0', PANTRY_REGISTRY_TOKEN: '', PANTRY_REGISTRY_URL: `http://127.0.0.1:${server.port}`,
        }
        const subprocess = Bun.spawn({
          cmd: [binary!, 'install', 'bun.sh@1.4.3', '--ignore-scripts', '--quiet', ...(force ? ['--force'] : [])],
          cwd: root, env, stdout: 'pipe', stderr: 'pipe',
        })
        child = subprocess
        timer = setTimeout(() => { expired = true; child?.kill() }, 30_000)
        const [stdout, stderr, code] = await Promise.all([
          new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited,
        ])
        clearTimeout(timer)
        writeFileSync(join(root, 'cli.stdout'), stdout)
        writeFileSync(join(root, 'cli.stderr'), stderr)
        const receipt = { force, code, expired, requests, sourceCLISHA256: new Bun.CryptoHasher('sha256').update(readFileSync(binary!)).digest('hex') }
        writeFileSync(join(root, 'result.json'), JSON.stringify(receipt))
        console.log(JSON.stringify({ nativeProviderFixture: receipt }))
        expect(expired, stdout + stderr).toBe(false)
        expect(code, stdout + stderr).not.toBe(0)
        expect(stdout + stderr).toContain('NativeSourceConflict')
        expect(requests).toEqual([])
        expect(existsSync(join(root, 'pantry.lock'))).toBe(false)
        expect(existsSync(join(root, 'pantry'))).toBe(false)
        expect(stdout + stderr).not.toContain('error(DebugAllocator)')
        passed = true
      }
      finally {
        if (timer) clearTimeout(timer)
        if (child && child.exitCode === null) {
          child.kill()
          await child.exited
        }
        await server?.stop(true)
        if (passed) rmSync(root, { recursive: true, force: true })
        else console.error(`Provider ownership evidence retained: ${root}`)
      }
    }, 60_000)
  }
})
