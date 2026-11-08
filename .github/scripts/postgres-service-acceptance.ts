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
const postgresVersion = process.env.PANTRY_SERVICE_TEST_POSTGRES_VERSION || '18.6.1'
assert(/^\d+(?:\.\d+){0,3}$/.test(postgresVersion), 'Use a numeric native PostgreSQL version or major range')
// A portable published artifact must run when the optional host ELF repair
// utility is absent. Refuse that repair explicitly in this isolated fixture;
// the actual CLI, native database tools and service manager stay unchanged.
const noRepairBin = join(root, 'without-host-elf-repair')
mkdirSync(noRepairBin)
writeFileSync(join(noRepairBin, 'patchelf'), '#!/bin/sh\nexit 127\n', { mode: 0o755 })
const env: Record<string, string> = {
  PATH: `${noRepairBin}:${process.env.PATH || '/usr/bin:/bin'}`, HOME: homedir(), USER: username, LOGNAME: username,
  LANG: 'C.UTF-8', XDG_RUNTIME_DIR: runtime, PANTRY_SERVICE_SCOPE: 'user', PANTRY_ENV_DEPS: '0',
}
const steps: Array<{ phase: string, exit: number, elapsedMs: number }> = []
let unit: string | undefined
let enabledLinger = false
let serviceAttempted = false
let qualified = false
let actualCliVersion: string | undefined
let installedNativeVersion: string | undefined
let actualUserManager = false

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
  writeFileSync(join(root, 'deps.yaml'), `dependencies:\n  postgresql.org: "${postgresVersion}"\n`)
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('synthetic admission') })
  const port = server.port!
  server.stop(true)
  const version = await run('cli-version', [cli, '--version'])
  actualCliVersion = version.trim()
  const expected = process.env.PANTRY_SERVICE_TEST_VERSION
  assert(expected === 'source' || (expected && version.includes(`pantry ${expected} `)), 'The actual public CLI must match the requested release')
  await run('install', [cli, 'install', '--ignore-scripts'])
  await run('frozen', [cli, 'install', '--frozen-lockfile', '--ignore-scripts'])
  const versions = readdirSync(join(root, 'pantry/postgresql.org'), { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('v'))
  assert.equal(versions.length, 1, 'The fresh project must own exactly one native PostgreSQL version')
  installedNativeVersion = versions[0].name.slice(1)
  const prefix = join(root, 'pantry/postgresql.org', versions[0].name)
  const postgres = join(prefix, 'bin/postgres')
  const psql = join(root, 'pantry/.bin/psql')
  assert(existsSync(postgres) && existsSync(psql))
  assert((await run('native-version', [postgres, '--version'])).includes(`PostgreSQL) ${postgresVersion.split('.').slice(0, 2).join('.')}`))
  await run('native-initdb-version', [join(prefix, 'bin/initdb'), '--version'])
  const libraries = await run('native-initdb-libraries', ['ldd', join(prefix, 'bin/initdb')])
  assert(!libraries.includes('not found'), 'The public artifact must resolve its native libraries without host repair')
  for (const line of libraries.split('\n').filter(line => /libpq\.so.*=>/.test(line)))
    assert(line.includes(`${prefix}/`), 'Do not borrow libpq from the CI host to hide an invalid package RPATH')
  writeFileSync(join(evidence, 'pantry.lock'), readFileSync(join(root, 'pantry.lock')))

  // The reported defect also affected --user routing and activated native
  // binaries. Keep that install in this fixture's home, never the CI user's
  // existing global tree, and require the normal CLI's printed destination.
  const userHome = join(root, 'user-home')
  mkdirSync(userHome)
  const userEnv = { ...env, HOME: userHome, XDG_DATA_HOME: join(userHome, '.local/share') }
  const userGlobal = join(userHome, '.local/share/pantry/global')
  const userInstall = await run('user-local-install', [cli, 'install', '--user', `postgresql.org@${postgresVersion}`], { environment: userEnv })
  assert(userInstall.includes(userGlobal) && !userInstall.includes('to /usr/local'), 'Explicit --user installation must select its user-owned global prefix')
  const userAlias = await run('user-local-short-alias', [cli, 'install', '-u', `postgresql.org@${postgresVersion}`], { environment: userEnv })
  assert(userAlias.includes(userGlobal) && !userAlias.includes('to /usr/local'), 'The -u alias must preserve explicit user scope')
  await run('user-local-native-version', [join(userGlobal, 'bin/postgres'), '--version'], { environment: userEnv })
  await run('user-local-initdb-version', [join(userGlobal, 'bin/initdb'), '--version'], { environment: userEnv })

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
  actualUserManager = true
  serviceAttempted = true
  await run('start', [cli, 'start', 'postgres', '--port', String(port)])
  const verifiedUnit = await run('verify-unit', ['systemd-analyze', '--user', 'verify', path])
  assert(!/unknown escape|ignoring.*escape/i.test(verifiedUnit), 'The actual unit must not contain the original escaping defect')
  const status = await run('service-status', ['systemctl', '--user', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID'])
  assert(status.includes('ActiveState=active') && status.includes('SubState=running'))
  const query = (sql: string) => [psql, '-X', '-A', '-t', '-w', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql]
  const serverVersion = Number((await run('server-version', query('SHOW server_version_num;'))).trim())
  assert.equal(Math.floor(serverVersion / 10000), Number(postgresVersion.split('.')[0]), 'The actual service must run the requested PostgreSQL major')
  // psql sends one -c string as one query message. Commit the seed separately
  // so the rollback exercises its own transaction rather than also removing
  // the table created earlier in that same message.
  await run('seed-committed-sql', query('CREATE TABLE acceptance_items (id INTEGER PRIMARY KEY); INSERT INTO acceptance_items VALUES (1);'))
  const sql = await run('actual-sql', query('BEGIN; INSERT INTO acceptance_items VALUES (2); ROLLBACK; SELECT COUNT(*) FROM acceptance_items;'))
  assert.equal(sql.trim().split('\n').at(-1), '1')
  await run('stop', [cli, 'stop', 'postgres'])
  await run('restart', [cli, 'start', 'postgres', '--port', String(port)])
  assert.equal((await run('retained-data', query('SELECT COUNT(*) FROM acceptance_items;'))).trim(), '1')
  qualified = true
} catch (error) {
  if (unit && existsSync(join(runtime, 'systemd/private'))) {
    await run('failure-unit-state', ['systemctl', '--user', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'Result', '-p', 'ExecMainStatus'], { allowFailure: true })
    await run('failure-unit-journal', ['journalctl', '--user', '--unit', unit, '--no-pager', '--lines=50'], { allowFailure: true })
    const content = readFileSync(join(unitDirectory, unit), 'utf8')
    const log = content.match(/^StandardError=append:(.+)$/m)?.[1]
    const hash = unit.match(/^pantry-([a-f0-9]+)-postgres\.service$/)?.[1]
    if (hash && log?.startsWith(join(homedir(), '.local/share/pantry/logs', hash) + '/') && existsSync(log))
      writeFileSync(join(evidence, 'failure-postgres.stderr'), readFileSync(log))
  }
  throw error
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
    qualified, cli, version: process.env.PANTRY_SERVICE_TEST_VERSION, sourceSha: process.env.GITHUB_SHA, nativePackage: `postgresql.org@${postgresVersion}`, installedNativeVersion, actualCliVersion, hostElfRepairAllowed: false,
    root, unit, actualUserManager, normalCliLifecycle: true, productionAccess: false,
    manualLoaderOverrides: false, steps, cleanupFailures,
  }, null, 2) + '\n')
  assert.equal(cleanupFailures.length, 0, `Cleanup did not complete: ${cleanupFailures.join('; ')}`)
}
