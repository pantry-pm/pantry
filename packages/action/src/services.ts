import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveNativeExecutable } from './native-executable'
import { recipeBuildVersion } from '../../ts-pantry/scripts/package-revisions'
import { recipe as postgresRecipe } from '../../ts-pantry/src/recipes/postgresql.org'

export interface ServiceSpec {
  name: 'redis' | 'postgres' | 'typesense' | 'mysql' | 'dynamodb'
  packageSpec: string
  /** The server's vendor version, distinct from a repaired package identity. */
  expectedVersion?: string
}

const serviceAliases: Record<string, ServiceSpec['name']> = {
  redis: 'redis',
  postgres: 'postgres',
  postgresql: 'postgres',
  'postgresql.org': 'postgres',
  typesense: 'typesense',
  'typesense.org': 'typesense',
  mysql: 'mysql',
  'mysql.com': 'mysql',
  dynamodb: 'dynamodb',
  'dynamodb-local': 'dynamodb',
  'aws.amazon.com/dynamodb-local': 'dynamodb',
}

const serviceDomains: Record<ServiceSpec['name'], string> = {
  redis: 'redis',
  postgres: 'postgresql.org',
  typesense: 'typesense.org',
  mysql: 'mysql.com',
  dynamodb: 'aws.amazon.com/dynamodb-local',
}

function serviceName(requested: string): ServiceSpec['name'] | undefined {
  return Object.hasOwn(serviceAliases, requested) ? serviceAliases[requested] : undefined
}

export function parseServiceSpecs(input: string): ServiceSpec[] {
  const services: ServiceSpec[] = []
  const seen = new Set<string>()
  for (const raw of input.split(/[\s,]+/).filter(Boolean)) {
    if (raw.split('@').length > 2) throw new Error(`Invalid Pantry Action service: ${raw}`)
    const [requested, version] = raw.split('@')
    const name = serviceName(requested || '')
    if (!name) throw new Error(`Unsupported Pantry Action service: ${requested}`)
    if (seen.has(name)) throw new Error(`Duplicate Pantry Action service: ${name}`)
    if (version !== undefined && !(name === 'redis' || name === 'mysql' || name === 'dynamodb' ? /^\d+\.\d+\.\d+$/ : /^\d+\.\d+(?:\.\d+)?$/).test(version))
      throw new Error(`Service versions must be exact semantic versions: ${raw}`)
    seen.add(name)
    const domain = serviceDomains[name]
    const expectedVersion = name === 'postgres' && version
      ? recipeBuildVersion(version, postgresRecipe.revisions).upstream
      : version
    services.push({ name, packageSpec: version ? `${domain}@${version}` : domain, expectedVersion })
  }
  return services
}

export function mergeServicePackages(packages: string, services: ServiceSpec[]): string {
  const requested = packages.split(/\s+/).filter(Boolean)
  for (const service of services) {
    const existing = requested.find(spec => serviceName(spec.split('@')[0] || '') === service.name)
    if (existing && existing.split('@')[1] !== service.packageSpec.split('@')[1])
      throw new Error(`Conflicting package and service versions for ${service.name}: ${existing} vs ${service.packageSpec}`)
    if (!existing) requested.push(service.packageSpec)
  }
  return requested.join(' ')
}

function canonicalPath(location: string): string {
  try { return fs.realpathSync(location) }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error
    return path.resolve(location)
  }
}

function nativeVersionRoot(location: string): string | undefined {
  let directory = path.dirname(path.resolve(location))
  for (;;) {
    if (/^v\d/.test(path.basename(directory))) return directory
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function nativeLibrarySelection(pantryBinDir: string): { libraries: string[], installed: Set<string>, activeParents: Set<string> } {
  const pantryRoot = path.resolve(path.dirname(pantryBinDir))
  const groups = new Map<string, Array<{ root: string, library: string }>>()
  const entriesAt = (directory: string): fs.Dirent[] => {
    try { return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)) }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error
      return []
    }
  }
  const visit = (directory: string, depth: number): void => {
    if (depth > 5) return
    for (const entry of entriesAt(directory)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const child = path.join(directory, entry.name)
      if (/^v\d/.test(entry.name)) {
        const library = path.join(child, 'lib')
        if (fs.existsSync(library)) {
          const records = groups.get(directory) || []
          records.push({ root: canonicalPath(child), library })
          groups.set(directory, records)
        }
      }
      else visit(child, depth + 1)
    }
  }
  visit(pantryRoot, 0)

  // Inspect the installer's activation contract without executing any launcher.
  const activeRoots = new Set<string>()
  for (const entry of entriesAt(pantryBinDir)) {
    if (entry.name.startsWith('.')) continue
    try {
      const executable = path.join(pantryBinDir, entry.name)
      if (!fs.statSync(executable).isFile()) continue
      const root = nativeVersionRoot(resolveNativeExecutable(executable))
      if (root) activeRoots.add(root)
    }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error
    }
  }
  const records = [...groups.values()].flat()
  const libraries: string[] = []
  for (const root of activeRoots) {
    const library = records.find(record => record.root === root)?.library || path.join(root, 'lib')
    if (fs.existsSync(library)) libraries.push(library)
  }
  for (const [directory, versions] of groups) {
    const domain = path.relative(pantryRoot, directory)
    const active = [...activeRoots].some(root => versions.some(record => record.root === root)
      || (domain && path.dirname(root).endsWith(path.sep + domain)))
    // Library-only providers are useful when unambiguous. A historical cache
    // is not an activation: never guess among its competing ABI versions.
    if (!active && versions.length === 1) libraries.push(versions[0].library)
  }
  return {
    libraries: [...new Set(libraries)],
    installed: new Set(records.flatMap(record => [path.resolve(record.library), canonicalPath(record.library)])),
    activeParents: new Set([...activeRoots].map(root => canonicalPath(path.dirname(root)))),
  }
}

export function pantryLibraryPaths(pantryBinDir: string): string[] {
  return nativeLibrarySelection(pantryBinDir).libraries
}

/** Follow the selected java executable, including globally cached JDK links. */
function selectedJavaHome(pantryBinDir: string): string | undefined {
  try {
    const java = resolveNativeExecutable(path.join(pantryBinDir, 'java'))
    const home = path.dirname(path.dirname(java))
    if (fs.existsSync(path.join(home, 'release')) && fs.existsSync(path.join(home, 'lib')))
      return home
  }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error
  }
}

export function nativeServiceEnvironment(
  pantryBinDir: string,
  platform: 'darwin' | 'linux' | 'windows',
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(baseEnvironment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  if (platform === 'windows') return environment
  environment.PATH = [...new Set([pantryBinDir, ...(environment.PATH?.split(path.delimiter) || [])].filter(Boolean))].join(path.delimiter)

  const javaHome = selectedJavaHome(pantryBinDir)
  if (javaHome) environment.JAVA_HOME = javaHome
  const javaLibraries = javaHome ? ['lib', 'jre/lib'].map(directory => path.join(javaHome, directory)).filter(directory => fs.existsSync(directory)) : []
  const variable = platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'
  const selection = nativeLibrarySelection(pantryBinDir)
  const inherited = (environment[variable]?.split(path.delimiter) || []).filter(library => {
    if (!library) return false
    if (selection.installed.has(canonicalPath(library))) return false
    const root = nativeVersionRoot(library)
    return !root || !selection.activeParents.has(canonicalPath(path.dirname(root)))
  })
  const value = [...new Set([...javaLibraries, ...selection.libraries, ...inherited])].join(path.delimiter)
  if (value) environment[variable] = value
  else delete environment[variable]
  return environment
}

export function redisLaunchArgs(tempDir: string, port = 6379): string[] {
  const serviceDir = path.join(tempDir, 'pantry-services', 'redis')
  return [
    '--bind', '127.0.0.1',
    '--port', String(port),
    '--protected-mode', 'yes',
    '--save', '',
    '--appendonly', 'no',
    '--daemonize', 'yes',
    '--dir', serviceDir,
    '--pidfile', path.join(serviceDir, 'redis.pid'),
    '--logfile', path.join(serviceDir, 'redis.log'),
  ]
}

export function readRedisPid(pidfile: string): number {
  if (!fs.existsSync(pidfile)) throw new Error(`Redis did not create its pidfile: ${pidfile}`)
  const pid = Number.parseInt(fs.readFileSync(pidfile, 'utf8').trim(), 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Redis wrote an invalid pidfile: ${pidfile}`)
  try {
    process.kill(pid, 0)
  }
  catch {
    throw new Error(`Redis process ${pid} is not running`)
  }
  return pid
}

export async function waitForRedisPid(
  pidfile: string,
  options: { timeoutMs?: number, intervalMs?: number } = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  do {
    try {
      return readRedisPid(pidfile)
    }
    catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  } while (Date.now() < deadline)

  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Redis pid did not become ready within ${timeoutMs}ms: ${detail}`)
}

export function readServiceLog(logfile: string): string {
  if (!fs.existsSync(logfile)) return 'Redis did not create a logfile'
  const content = fs.readFileSync(logfile, 'utf8').trim()
  return content || 'Redis logfile was empty'
}

export function parseRedisVersion(output: string): string {
  const match = output.match(/\bv=(\d+\.\d+\.\d+)\b/)
  if (!match) throw new Error(`Could not determine Redis version from: ${output.trim()}`)
  return match[1]
}
