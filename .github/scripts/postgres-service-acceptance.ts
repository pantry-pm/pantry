import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'

assert.equal(process.platform, 'linux', 'This acceptance requires a real Linux systemd user manager')
assert.notEqual(process.getuid!(), 0, 'Run as the ordinary CI user with sudo available')
const cli = process.env.PANTRY_SERVICE_TEST_CLI
assert(cli && existsSync(cli), 'Provide the actual published or normally built CLI')
const evidence = resolve('artifacts/postgres-user-service')
mkdirSync(evidence, { recursive: true })
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'pantry-postgres-service-'))
const unitDirectory = join(homedir(), '.config/systemd/user')
const beforeUnits = new Set(existsSync(unitDirectory) ? readdirSync(unitDirectory) : [])
const uid = process.getuid!()
const username = userInfo().username
const runtime = `/run/user/${uid}`
const env: Record<string, string> = {
  PATH: process.env.PATH || '/usr/bin:/bin', HOME: homedir(), USER: username, LOGNAME: username,
  LANG: 'C.UTF-8', XDG_RUNTIME_DIR: runtime, PANTRY_SERVICE_SCOPE: 'user', PANTRY_ENV_DEPS: '0',
}
const steps: Array<{ phase: string, exit: number, elapsedMs: number }> = []
let unit: string | undefined
let enabledLinger = false
let serviceAttempted = false
let qualified = false

async function run(phase: string, command: string[], options: { expectedFailure?: boolean, allowFailure?: boolean, environment?: Record<string, string>, timeoutMs?: number } = {}): Promise<string> {
  const started = Date.now()
  const child = Bun.spawn(command, { cwd: root, env: options.environment ?? env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs ?? 120_000)
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    writeFileSync(join(evidence, `${phase}.stdout`), stdout)
    writeFileSync(join(evidence, `${phase}.stderr`), stderr)
    steps.push({ phase, exit, elapsedMs: Date.now() - started })
    assert(!timedOut, `${phase} exceeded its bounded acceptance deadline`)
    if (options.expectedFailure) assert.notEqual(exit, 0, `${phase} must reject missing prerequisites`)
    else if (!options.allowFailure) assert.equal(exit, 0, `${phase} failed: ${stderr.slice(-1500)}`)
    return stdout + stderr
  } finally { clearTimeout(guard) }
}

function discoverUnit(): string | undefined {
  if (!existsSync(unitDirectory)) return undefined
  const added = readdirSync(unitDirectory).filter(name => !beforeUnits.has(name) && /^pantry-[a-f0-9]+-postgres\.service$/.test(name))
  assert(added.length <= 1, 'Only this isolated project may create a PostgreSQL unit')
  return added[0]
}

try {
  writeFileSync(join(root, 'deps.yaml'), 'dependencies:\n  postgresql.org: 18.6.1\n')
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('synthetic admission') })
  const port = server.port!
  server.stop(true)
  const version = await run('cli-version', [cli, '--version'])
  const expected = process.env.PANTRY_SERVICE_TEST_VERSION
  assert(expected === 'source' || (expected && version.includes(`pantry ${expected} `)), 'The actual public CLI must match the requested release')
  await run('install', [cli, 'install', '--ignore-scripts'])
  await run('frozen', [cli, 'install', '--frozen-lockfile', '--ignore-scripts'])
  const postgres = join(root, 'pantry/postgresql.org/v18.6.1/bin/postgres')
  const psql = join(root, 'pantry/.bin/psql')
  assert(existsSync(postgres) && existsSync(psql))
  assert((await run('native-version', [postgres, '--version'])).includes('18.6'))
  await run('native-initdb-version', [join(root, 'pantry/postgresql.org/v18.6.1/bin/initdb'), '--version'])

  // Exercise the real missing-bus decision before enabling the normal user
  // manager. No shim or hand-written service takes the CLI's place.
  const missingBus = await run('missing-user-bus', [cli, 'start', 'postgres', '--port', String(port)], {
    expectedFailure: true, environment: { ...env, XDG_RUNTIME_DIR: join(root, 'no-user-manager') },
  })
  assert(missingBus.includes('No systemd user manager') && missingBus.includes('loginctl enable-linger'))
  unit = discoverUnit()
  assert(unit, 'The CLI must scope the unit to this project')
  const path = join(unitDirectory, unit)
  const content = readFileSync(path, 'utf8')
  assert(content.includes(root), 'The generated unit must identify this exact project')
  const exec = content.split('\n').find(line => line.startsWith('ExecStart='))
  assert(exec?.startsWith('ExecStart=/bin/sh ') && !exec.includes('$('), 'Use the normal saved service script, not an inline shell expression')
  writeFileSync(join(evidence, 'generated.service'), content)

  const linger = await run('linger-before', ['loginctl', 'show-user', username, '-p', 'Linger', '--value'], { allowFailure: true })
  if (steps.at(-1)!.exit !== 0) assert(linger.includes('not logged in'), 'Only an absent user session may lack Linger metadata')
  if (!existsSync(join(runtime, 'systemd/private'))) {
    if (linger.trim() !== 'yes') {
      await run('enable-linger', ['sudo', '-n', 'loginctl', 'enable-linger', username])
      enabledLinger = true
    }
    await run('user-manager', ['sudo', '-n', 'systemctl', 'start', `user@${uid}.service`])
  }
  assert(existsSync(join(runtime, 'systemd/private')), 'The actual user bus must be available')
  serviceAttempted = true
  await run('start', [cli, 'start', 'postgres', '--port', String(port)])
  const verifiedUnit = await run('verify-unit', ['systemd-analyze', '--user', 'verify', path])
  assert(!/unknown escape|ignoring.*escape/i.test(verifiedUnit), 'The actual unit must not contain the original escaping defect')
  const status = await run('service-status', ['systemctl', '--user', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID'])
  assert(status.includes('ActiveState=active') && status.includes('SubState=running'))
  const query = (sql: string) => [psql, '-X', '-A', '-t', '-w', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql]
  const sql = await run('actual-sql', query('CREATE TABLE acceptance_items (id INTEGER PRIMARY KEY); INSERT INTO acceptance_items VALUES (1); BEGIN; INSERT INTO acceptance_items VALUES (2); ROLLBACK; SELECT COUNT(*) FROM acceptance_items;'))
  assert.equal(sql.trim().split('\n').at(-1), '1')
  await run('stop', [cli, 'stop', 'postgres'])
  await run('restart', [cli, 'start', 'postgres', '--port', String(port)])
  assert.equal((await run('retained-data', query('SELECT COUNT(*) FROM acceptance_items;'))).trim(), '1')
  qualified = true
} finally {
  const cleanupFailures: string[] = []
  const cleanup = async (action: () => Promise<unknown> | void) => {
    try { await action() } catch (error) { cleanupFailures.push(String(error)) }
  }
  await cleanup(() => { unit ??= discoverUnit() })
  if (serviceAttempted) await cleanup(() => run('cleanup-stop', [cli, 'stop', 'postgres']))
  if (unit) await cleanup(async () => {
    const path = join(unitDirectory, unit!)
    assert(readFileSync(path, 'utf8').includes(root), 'Never remove a unit owned by another project')
    if (existsSync(join(runtime, 'systemd/private'))) await run('cleanup-disable', ['systemctl', '--user', 'disable', unit!])
    rmSync(path)
    if (existsSync(join(runtime, 'systemd/private'))) await run('cleanup-reload', ['systemctl', '--user', 'daemon-reload'])
  })
  if (enabledLinger) await cleanup(() => run('restore-linger', ['sudo', '-n', 'loginctl', 'disable-linger', username]))
  qualified &&= cleanupFailures.length === 0
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify({
    qualified, cli, version: process.env.PANTRY_SERVICE_TEST_VERSION, nativePackage: 'postgresql.org18.6.1',
    root, unit, actualUserManager: true, normalCliLifecycle: true, productionAccess: false,
    manualLoaderOverrides: false, steps, cleanupFailures,
  }, null, 2) + '\n')
  assert.equal(cleanupFailures.length, 0, `Cleanup did not complete: ${cleanupFailures.join('; ')}`)
}
