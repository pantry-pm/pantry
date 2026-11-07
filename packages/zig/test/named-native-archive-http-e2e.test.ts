import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const binary = process.env.PANTRY_SOURCE_CLI
const domains = ['first.pantry-fixture.test', 'second.pantry-fixture.test']
const bareNative = 'pantry-fixture-native-tool'
const machoCandidate = 'macho.pantry-fixture.test'
const checksumDomains = ['checksum-mismatch.pantry-fixture.test', 'checksum-missing.pantry-fixture.test', 'checksum-invalid.pantry-fixture.test']

// Real source CLI and native HTTP. These payloads are fixture data, not a
// released native SDK, engine, or platform execution claim.
describe.skipIf(!binary)('named native archive acquisition over HTTP', () => {
  test('overlaps cold archives and restores exact locked artifacts without saving', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry-named-archive-http-'))
    let passed = false
    let child: ReturnType<typeof Bun.spawn> | undefined
    let server: ReturnType<typeof Bun.serve> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const requests: { phase: string, path: string }[] = []
    let phase = 'cold'
    let arrivals = new Set<string>()
    let release!: () => void
    let bothArrived = new Promise<void>((resolve) => { release = resolve })
    try {
      const stage = join(root, 'stage/share')
      mkdirSync(stage, { recursive: true })
      const payload = 'Named native archive HTTP fixture\n'
      writeFileSync(join(stage, 'fixture.txt'), payload)
      for (const directory of ['bin', 'sbin', 'lib']) {
        mkdirSync(join(root, 'stage', directory), { recursive: true })
        writeFileSync(join(root, 'stage', directory, 'fixture-script'), '#!/bin/sh\nprintf fixture\n')
        chmodSync(join(root, 'stage', directory, 'fixture-script'), 0o755)
        writeFileSync(join(root, 'stage', directory, 'fixture.a'), '!<arch>\nfixture archive data\n')
        for (let length = 0; length < 4; length++) writeFileSync(join(root, 'stage', directory, `short-${length}`), Buffer.alloc(length, 0xfe))
      }
      const spy = join(root, 'spy')
      const spyLog = join(root, 'tool-calls.log')
      mkdirSync(spy)
      for (const tool of ['otool', 'install_name_tool', 'codesign']) {
        writeFileSync(join(spy, tool), "#!/bin/sh\nprintf '%s\\n' \"$0 $*\" >> \"$PANTRY_TOOL_SPY_LOG\"\nexit 1\n")
        chmodSync(join(spy, tool), 0o755)
      }
      const archivePath = join(root, 'fixture.tar.gz')
      const tar = spawnSync('tar', ['-czf', archivePath, '-C', join(root, 'stage'), 'share', 'bin', 'sbin', 'lib'], { encoding: 'utf8', timeout: 5000 })
      expect(tar.error).toBeUndefined()
      expect(tar.status, tar.stderr).toBe(0)
      const archive = readFileSync(archivePath)
      const digest = new Bun.CryptoHasher('sha256').update(archive).digest('hex')
      const candidateStage = join(root, 'candidate-stage')
      mkdirSync(join(candidateStage, 'bin'), { recursive: true })
      mkdirSync(join(candidateStage, 'lib'))
      // Header candidates only. Spy tools observe admission; these files are
      // never executed and are not claims of valid binaries or signing.
      const magics = ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']
      for (const magic of magics) writeFileSync(join(candidateStage, 'bin', `candidate-${magic}`), Buffer.from(magic, 'hex'))
      writeFileSync(join(candidateStage, 'lib/candidate.dylib'), Buffer.from('cffaedfe', 'hex'))
      const candidatePath = join(root, 'candidate.tar.gz')
      const candidateTar = spawnSync('tar', ['-czf', candidatePath, '-C', candidateStage, 'bin', 'lib'], { encoding: 'utf8', timeout: 5000 })
      expect(candidateTar.error).toBeUndefined()
      expect(candidateTar.status, candidateTar.stderr).toBe(0)
      const candidateArchive = readFileSync(candidatePath)
      const candidateDigest = new Bun.CryptoHasher('sha256').update(candidateArchive).digest('hex')
      const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'x86-64' : process.arch}`
      server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname
          requests.push({ phase, path })
          for (const domain of [...domains, bareNative, machoCandidate, ...checksumDomains]) {
            if (path === `/binaries/${domain}/metadata.json`) {
              const versions = Object.fromEntries(['1.0.0', '1.1.0'].map(version => [version, { platforms: { [platform]: {
                tarball: `binaries/${domain}/${version}/${platform}/fixture.tar.gz`,
                ...(domain === checksumDomains[1] ? {} : { sha256: domain === checksumDomains[0] ? '0'.repeat(64) : domain === checksumDomains[2] ? 'invalid' : domain === machoCandidate ? candidateDigest : digest }),
                size: domain === machoCandidate ? candidateArchive.length : archive.length,
              } } }]))
              return Response.json({ versions })
            }
            if (domain === checksumDomains[1] && path === `/binaries/${domain}/1.0.0/${platform}/fixture.tar.gz.sha256`) return new Response(`${digest}  fixture.tar.gz\n`)
            if (checksumDomains.includes(domain) && path === `/binaries/${domain}/1.0.0/${platform}/fixture.tar.gz`) return new Response(archive, { headers: { 'Content-Length': String(archive.length) } })
            if (domain === machoCandidate && path === `/binaries/${domain}/1.0.0/${platform}/fixture.tar.gz`) {
              return new Response(candidateArchive, { headers: { 'Content-Length': String(candidateArchive.length) } })
            }
            if (domain === bareNative && ['1.0.0', '1.1.0'].some(version => path === `/binaries/${domain}/${version}/${platform}/fixture.tar.gz`)) {
              return new Response(archive, { headers: { 'Content-Length': String(archive.length) } })
            }
            if (path === `/binaries/${domain}/1.0.0/${platform}/fixture.tar.gz`) {
              arrivals.add(domain)
              if (arrivals.size === domains.length) release()
              await bothArrived
              return new Response(archive, { headers: { 'Content-Length': String(archive.length) } })
            }
          }
          return new Response('unexpected fixture request', { status: 404 })
        },
      })
      mkdirSync(join(root, 'home'))
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'named-native-http-fixture', private: true }))
      const env = {
        ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), LOCALAPPDATA: join(root, 'local-app-data'),
        XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'),
        PANTRY_TOOL_SPY_LOG: spyLog, PATH: `${spy}:${process.env.PATH ?? ''}`,
        PANTRY_ENV_DEPS: '0', PANTRY_REGISTRY_ACCELERATION: '0', PANTRY_REGISTRY_URL: `http://127.0.0.1:${server.port}`, PANTRY_REGISTRY_TOKEN: '',
      }
      async function install(label: string, args: string[], cwd = root, expectedCode = 0, expectedError?: string, installEnv = env) {
        let expired = false
        const subprocess = Bun.spawn({ cmd: [binary!, 'install', ...args, '--ignore-scripts', '--quiet'], cwd, env: installEnv, stdout: 'pipe', stderr: 'pipe' })
        child = subprocess
        timer = setTimeout(() => { expired = true; subprocess.kill() }, 30_000)
        const [stdout, stderr, code] = await Promise.all([
          new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited,
        ])
        clearTimeout(timer)
        timer = undefined
        writeFileSync(join(root, `${label}.stdout`), stdout)
        writeFileSync(join(root, `${label}.stderr`), stderr)
        writeFileSync(join(root, `${label}.json`), JSON.stringify({ args, cwd, code, expired, requests, arrivals: [...arrivals] }))
        expect(expired, stdout + stderr).toBe(false)
        expect(code, stdout + stderr).toBe(expectedCode)
        if (expectedError) expect(stdout + stderr).toContain(expectedError)
        expect(stdout + stderr).not.toContain('error(DebugAllocator)')
      }
      const exact = domains.map(domain => `${domain}@1.0.0`)
      await install('cold', exact)
      expect(arrivals.size).toBe(2)
      const lockBytes = readFileSync(join(root, 'pantry.lock'))
      const manifestBytes = readFileSync(join(root, 'deps.yaml'))
      const packageBytes = readFileSync(join(root, 'package.json'))
      phase = 'warm'
      await install('warm', [...exact.toReversed(), '--no-save', '--frozen-lockfile'])
      expect(requests.filter(item => item.phase === 'warm' && item.path.startsWith('/binaries/'))).toEqual([])
      expect(readFileSync(join(root, 'pantry.lock'))).toEqual(lockBytes)
      expect(readFileSync(join(root, 'deps.yaml'))).toEqual(manifestBytes)
      rmSync(join(root, 'pantry'), { recursive: true })
      phase = 'restore'
      arrivals = new Set()
      bothArrived = new Promise<void>((resolve) => { release = resolve })
      await install('restore', [...domains.toReversed().map(domain => `${domain}@^1`), '--no-save', '--frozen-lockfile'])
      expect(arrivals.size).toBe(2)
      // Inventory physical version directories independently of generated lock.
      const inventory = Object.fromEntries(domains.map(domain => [domain, readdirSync(join(root, 'pantry', domain), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()]))
      writeFileSync(join(root, 'inventory.json'), JSON.stringify(inventory))
      for (const domain of domains) {
        expect(inventory[domain]).toEqual(['v1.0.0'])
        expect(readFileSync(join(root, 'pantry', domain, 'v1.0.0/share/fixture.txt'), 'utf8')).toBe(payload)
        expect(requests.filter(item => item.phase === 'restore' && item.path === `/binaries/${domain}/metadata.json`)).toHaveLength(1)
        expect(requests.filter(item => item.phase === 'restore' && item.path === `/binaries/${domain}/1.0.0/${platform}/fixture.tar.gz`)).toHaveLength(1)
        expect(requests.some(item => item.path.includes(`/${domain}/1.1.0/`))).toBe(false)
      }
      expect(readFileSync(join(root, 'pantry.lock'))).toEqual(lockBytes)
      expect(readFileSync(join(root, 'deps.yaml'))).toEqual(manifestBytes)
      expect(readFileSync(join(root, 'package.json'))).toEqual(packageBytes)
      expect(existsSync(join(root, 'pantry.lock'))).toBe(true)

      // No lock exists in this second project. Latest native 1.1.0 misses
      // ~1.0, so discovery must retain native provenance for plan selection.
      const fresh = join(root, 'fresh')
      mkdirSync(fresh)
      writeFileSync(join(fresh, 'package.json'), JSON.stringify({ name: 'fresh-native-http-fixture', private: true }))
      phase = 'fresh-range'
      arrivals = new Set()
      bothArrived = new Promise<void>((resolve) => { release = resolve })
      await install('fresh-range', domains.map(domain => `${domain}@~1.0`), fresh)
      const freshLock = JSON.parse(readFileSync(join(fresh, 'pantry.lock'), 'utf8'))
      writeFileSync(join(root, 'fresh-generated-lock.json'), JSON.stringify(freshLock))
      for (const domain of domains) {
        expect(freshLock.packages[`${domain}@1.0.0`].source).toBe('pantry')
        expect(readFileSync(join(fresh, 'pantry', domain, 'v1.0.0/share/fixture.txt'), 'utf8')).toBe(payload)
        expect(requests.filter(item => item.phase === 'fresh-range' && item.path === `/packages/${domain}`)).toHaveLength(1)
        expect(requests.some(item => item.phase === 'fresh-range' && item.path.includes(`/${domain}/1.1.0/`))).toBe(false)
      }

      // A normal companion/workspace producer establishes a bare native name
      // that has no catalog entry and is absent from the JS package endpoint.
      const forceRoot = join(root, 'force-native')
      mkdirSync(join(forceRoot, 'packages/local'), { recursive: true })
      writeFileSync(join(forceRoot, 'package.json'), JSON.stringify({ name: 'force-native-http-fixture', private: true, workspaces: ['packages/*'], dependencies: { '@pantry-fixture/local': 'workspace:*' } }))
      writeFileSync(join(forceRoot, 'packages/local/package.json'), JSON.stringify({ name: '@pantry-fixture/local', version: '1.0.0', private: true }))
      writeFileSync(join(forceRoot, 'deps.yaml'), `dependencies:\n  ${bareNative}: 1.0.0\n`)
      phase = 'bare-seed'
      await install('bare-seed', [], forceRoot)
      const forceLock = readFileSync(join(forceRoot, 'pantry.lock'))
      const forceManifest = readFileSync(join(forceRoot, 'deps.yaml'))
      expect(JSON.parse(forceLock.toString()).packages[`${bareNative}@1.0.0`].source).toBe('pantry')
      phase = 'bare-force'
      await install('bare-force', [`${bareNative}@1.1.0`, '--force', '--no-save'], forceRoot)
      const forceVersions = readdirSync(join(forceRoot, 'pantry', bareNative), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
      writeFileSync(join(root, 'force-inventory.json'), JSON.stringify(forceVersions))
      expect(forceVersions).toEqual(['v1.0.0', 'v1.1.0'])
      expect(readFileSync(join(forceRoot, 'pantry', bareNative, 'v1.1.0/share/fixture.txt'), 'utf8')).toBe(payload)
      expect(readFileSync(join(forceRoot, 'pantry.lock'))).toEqual(forceLock)
      expect(readFileSync(join(forceRoot, 'deps.yaml'))).toEqual(forceManifest)
      expect(requests.filter(item => item.phase === 'bare-force' && item.path.startsWith('/packages/'))).toEqual([])
      expect(requests.filter(item => item.phase === 'bare-force' && item.path === `/binaries/${bareNative}/1.1.0/${platform}/fixture.tar.gz`)).toHaveLength(1)
      if (process.platform === 'darwin') {
        expect(existsSync(spyLog), existsSync(spyLog) ? readFileSync(spyLog, 'utf8') : '').toBe(false)
        phase = 'macho-candidate'
        await install('macho-candidate', [`${machoCandidate}@1.0.0`])
        const calls = readFileSync(spyLog, 'utf8')
        writeFileSync(join(root, 'macho-tool-calls.txt'), calls)
        for (const magic of magics) {
          expect(calls).toContain(`candidate-${magic}`)
          expect(calls).toContain(`codesign -s - -f ${realpathSync(root)}/pantry/${machoCandidate}/v1.0.0/bin/candidate-${magic}`)
        }
        expect(calls).toContain('candidate.dylib')
      }
      for (const [index, domain] of checksumDomains.entries()) {
        const checksumRoot = join(root, `checksum-${index}`)
        mkdirSync(checksumRoot)
        writeFileSync(join(checksumRoot, 'package.json'), JSON.stringify({ name: `native-checksum-${index}`, private: true }))
        phase = `checksum-${index}`
        await install(`checksum-${index}`, [`${domain}@1.0.0`], checksumRoot, index === 1 ? 0 : 1, index === 0 ? 'checksum mismatch' : index === 2 ? 'InvalidRegistryMetadata' : undefined)
        const bodyPath = `/binaries/${domain}/1.0.0/${platform}/fixture.tar.gz`
        expect(requests.filter(item => item.phase === phase && item.path === bodyPath)).toHaveLength(index === 2 ? 0 : 1)
        expect(requests.filter(item => item.phase === phase && item.path === `${bodyPath}.sha256`)).toHaveLength(index === 1 ? 1 : 0)
        if (index === 1) expect(readFileSync(join(checksumRoot, 'pantry', domain, 'v1.0.0/share/fixture.txt'), 'utf8')).toBe(payload)
        else {
          expect(existsSync(join(checksumRoot, 'pantry', domain, 'v1.0.0'))).toBe(false)
          expect(existsSync(join(checksumRoot, 'pantry.lock'))).toBe(false)
        }
      }
      // Ordinary project entry must overlap cold native body acquisition too.
      // A fresh private home/cache prevents the earlier named cases from
      // satisfying this through any global or archive cache.
      const pipelineRoot = join(root, 'pipeline')
      const pipelineHome = join(root, 'pipeline-home')
      mkdirSync(pipelineRoot)
      mkdirSync(pipelineHome)
      writeFileSync(join(pipelineRoot, 'package.json'), JSON.stringify({ name: 'native-pipeline-http-fixture', private: true }))
      writeFileSync(join(pipelineRoot, 'deps.yaml'), `dependencies:\n  ${domains[0]}: 1.0.0\n  ${domains[1]}: 1.0.0\n`)
      const pipelineEnv = { ...env, HOME: pipelineHome, USERPROFILE: pipelineHome, LOCALAPPDATA: join(root, 'pipeline-local-app-data'), XDG_DATA_HOME: join(root, 'pipeline-data'), XDG_CACHE_HOME: join(root, 'pipeline-cache'), XDG_CONFIG_HOME: join(root, 'pipeline-config') }
      phase = 'pipeline-cold'
      arrivals = new Set()
      bothArrived = new Promise<void>((resolve) => { release = resolve })
      await install('pipeline-cold', [], pipelineRoot, 0, undefined, pipelineEnv)
      expect(arrivals.size).toBe(2)
      for (const domain of domains) {
        expect(readFileSync(join(pipelineRoot, 'pantry', domain, 'v1.0.0/share/fixture.txt'), 'utf8')).toBe(payload)
        expect(requests.filter(item => item.phase === phase && item.path === `/binaries/${domain}/1.0.0/${platform}/fixture.tar.gz`)).toHaveLength(1)
      }
      const pipelineLock = JSON.parse(readFileSync(join(pipelineRoot, 'pantry.lock'), 'utf8'))
      for (const domain of domains) {
        const entry = pipelineLock.packages[`${domain}@1.0.0`]
        expect(entry.name).toBe(domain)
        expect(entry.version).toBe('1.0.0')
        expect(entry.resolved).toBe(`registry:${domain}@1.0.0`)
        // The maintained lower lock format accepts absent native provenance;
        // an explicit nonnative or invalid source is still rejected here.
        expect([undefined, 'pantry']).toContain(entry.source)
      }
      expect(requests.filter(item => item.phase === 'cold' && item.path.endsWith('.sha256'))).toHaveLength(0)
      expect(requests.filter(item => item.phase === 'restore' && item.path.endsWith('.sha256'))).toHaveLength(0)
      writeFileSync(join(root, 'result.json'), JSON.stringify({ requests, inventory, archiveSHA256: digest, sourceCLISHA256: new Bun.CryptoHasher('sha256').update(readFileSync(binary!)).digest('hex') }))
      console.log(JSON.stringify({ namedArchiveHTTPFixture: { requests, inventory } }))
      passed = true
    }
    finally {
      if (timer) clearTimeout(timer)
      release?.()
      if (child && child.exitCode === null) { child.kill(); await child.exited }
      await server?.stop(true)
      if (passed) rmSync(root, { recursive: true, force: true })
      else console.error(`Named archive HTTP evidence retained: ${root}`)
    }
  }, 60_000)
})
