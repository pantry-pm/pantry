import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const binary = process.env.PANTRY_SOURCE_CLI

// This POSIX executable is a package-interface fixture, not a Zig SDK or a
// published artifact. The real declared compiler has separate qualification.
describe.skipIf(!binary || process.platform === 'win32')('source CLI native cache repair', () => {
  for (const nested of [false, true]) {
    test(`a normal install repairs a selected Zig payload${nested ? ' with an unusable root and nested old program' : ' whose executable was removed'}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'pantry-zig-cache-repair-'))
      const requests: string[] = []
      const commands: Array<{ code: number, expired: boolean }> = []
      let server: ReturnType<typeof Bun.serve> | undefined
      let child: ReturnType<typeof Bun.spawn> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let passed = false
      let archiveSHA256: string | undefined
      try {
        const stage = join(root, 'stage')
        mkdirSync(join(stage, 'bin'), { recursive: true })
        mkdirSync(join(stage, 'lib'))
        const program = "#!/bin/sh\nprintf 'fixture-zig-0.17.1\\n'\n"
        writeFileSync(join(stage, 'bin/zig'), program)
        chmodSync(join(stage, 'bin/zig'), 0o755)
        const archivePath = join(root, 'fixture.tar.gz')
        const tar = spawnSync('tar', ['-czf', archivePath, '-C', stage, 'bin', 'lib'], { encoding: 'utf8', timeout: 5000 })
        expect(tar.error).toBeUndefined()
        expect(tar.status, tar.stderr).toBe(0)
        const archive = readFileSync(archivePath)
        const digest = new Bun.CryptoHasher('sha256').update(archive).digest('hex')
        archiveSHA256 = digest
        const platform = `${process.platform === 'darwin' ? 'darwin' : process.platform}-${process.arch === 'x64' ? 'x86-64' : process.arch}`
        const tarball = `/binaries/ziglang.org/0.17.1/${platform}/fixture.tar.gz`
        server = Bun.serve({
          hostname: '127.0.0.1', port: 0,
          fetch(request) {
            const path = new URL(request.url).pathname
            requests.push(path)
            if (path === '/binaries/ziglang.org/metadata.json') return Response.json({ versions: { '0.17.1': { platforms: { [platform]: { tarball: tarball.slice(1), sha256: digest, size: archive.length } } } } })
            if (path === tarball) return new Response(archive, { headers: { 'Content-Length': String(archive.length) } })
            return new Response('unexpected fixture request', { status: 404 })
          },
        })
        mkdirSync(join(root, 'home'))
        mkdirSync(join(root, 'packages/local'), { recursive: true })
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'native-cache-fixture', private: true, workspaces: ['packages/*'] }))
        writeFileSync(join(root, 'packages/local/package.json'), JSON.stringify({ name: '@pantry-fixture/local', version: '1.0.0', private: true }))
        writeFileSync(join(root, 'deps.yaml'), 'dependencies:\n  ziglang.org: 0.17.1\n')
        const env = {
          ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), LOCALAPPDATA: join(root, 'local-app-data'),
          XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'),
          PANTRY_ENV_DEPS: '0', PANTRY_REGISTRY_ACCELERATION: '0', PANTRY_REGISTRY_TOKEN: '', PANTRY_REGISTRY_URL: `http://127.0.0.1:${server.port}`,
        }
        const run = async (label: string) => {
          let expired = false
          const subprocess = Bun.spawn({ cmd: [binary!, 'install', '--ignore-scripts', '--quiet'], cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
          child = subprocess
          timer = setTimeout(() => { expired = true; child?.kill() }, 30_000)
          const [stdout, stderr, code] = await Promise.all([new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited])
          clearTimeout(timer)
          commands.push({ code, expired })
          writeFileSync(join(root, `${label}.stdout`), stdout)
          writeFileSync(join(root, `${label}.stderr`), stderr)
          expect(expired, stdout + stderr).toBe(false)
          expect(code, stdout + stderr).toBe(0)
          expect(stdout + stderr).not.toContain('error(DebugAllocator)')
        }
        await run('seed')
        const selected = join(root, 'pantry/ziglang.org/v0.17.1/bin/zig')
        expect(readFileSync(selected, 'utf8')).toBe(program)
        const originalLock = readFileSync(join(root, 'pantry.lock'))
        expect(requests.filter(path => path === tarball)).toHaveLength(1)
        unlinkSync(selected)
        expect(existsSync(selected)).toBe(false)
        if (nested) {
          const nestedProgram = join(root, 'pantry/ziglang.org/v0.17.1/v0.17.0/bin/zig')
          mkdirSync(join(root, 'pantry/ziglang.org/v0.17.1/v0.17.0/bin'), { recursive: true })
          writeFileSync(nestedProgram, "#!/bin/sh\nprintf 'fixture-zig-0.17.0\\n'\n")
          chmodSync(nestedProgram, 0o755)
        }
        await run('repair')
        expect(existsSync(selected)).toBe(true)
        expect(readFileSync(selected, 'utf8')).toBe(program)
        expect(requests.filter(path => path === tarball)).toHaveLength(2)
        expect(readFileSync(join(root, 'pantry.lock'))).toEqual(originalLock)
        const invoked = spawnSync(join(root, 'pantry/.bin/zig'), ['version'], { cwd: root, env, encoding: 'utf8', timeout: 5000 })
        expect(invoked.error).toBeUndefined()
        expect(invoked.status, invoked.stderr).toBe(0)
        expect(invoked.stdout.trim()).toBe('fixture-zig-0.17.1')
        passed = true
      }
      finally {
        if (timer) clearTimeout(timer)
        if (child && child.exitCode === null) {
          child.kill()
          await child.exited
        }
        await server?.stop(true)
        const receipt = { nested, commands, requests, archiveSHA256, sourceCLISHA256: new Bun.CryptoHasher('sha256').update(readFileSync(binary!)).digest('hex'), passed }
        writeFileSync(join(root, 'result.json'), JSON.stringify(receipt))
        console.log(JSON.stringify({ nativeCacheRepairFixture: receipt }))
        if (passed) rmSync(root, { recursive: true, force: true })
        else console.error(`Native cache repair evidence retained: ${root}`)
      }
    }, 60_000)
  }
})
