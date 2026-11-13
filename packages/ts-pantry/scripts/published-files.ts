import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { resolveRuntimeEnvironment, type RuntimeEnvironment } from './runtime-environment'

/** Apply the recipe's public product boundary before inspecting native runtimes. */
export function selectPublishedFiles(prefix: string, patterns?: string[]): void {
  if (!patterns) return
  if (!patterns.length || patterns.some(pattern => pattern.startsWith('/') || pattern.split('/').includes('..')))
    throw new Error('Published file patterns must be nonempty and package-relative')
  const matchers = patterns.map(pattern => new Bun.Glob(pattern))
  const files: string[] = []
  const directories: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (lstatSync(path).isDirectory()) {
        walk(path)
        directories.push(path)
      }
      else files.push(path)
    }
  }
  walk(prefix)
  const selected = files.filter(path => matchers.some(pattern => pattern.match(relative(prefix, path))))
  if (!selected.length) throw new Error('Published file selection contains no package products')
  const keep = new Set(selected)
  for (const file of files) if (!keep.has(file)) unlinkSync(file)
  for (const directory of directories) if (!readdirSync(directory).length) rmdirSync(directory)
}

/** Declare source interfaces in the checksummed artifact, independent of installer catalogs. */
export function writeProgramInterfaces(prefix: string, sourceablePrograms?: string[]): void {
  if (!sourceablePrograms) return
  if (sourceablePrograms.some(name => !/^[a-zA-Z0-9_.+-]+$/.test(name) || !existsSync(join(prefix, 'bin', name))))
    throw new Error('Sourceable programs must name existing package bin files')
  const directory = join(prefix, 'share/pantry')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'interfaces.json'), JSON.stringify({ version: 1, sourceablePrograms }) + '\n')
}

/** Keep runtime defaults with the checksummed package instead of its build prefix. */
export function writeRuntimeEnvironment(prefix: string, environment?: RuntimeEnvironment): void {
  if (!environment) return
  resolveRuntimeEnvironment(environment, prefix)
  const variables = Object.entries(environment).map(([name, value]) => ({ name, value }))
  const content = JSON.stringify({ version: 1, environment: variables }) + '\n'
  if (Buffer.byteLength(content) > 64 * 1024)
    throw new Error('Package runtime environment exceeds its metadata limit')
  const directory = join(prefix, 'share/pantry')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'runtime.json'), content)
}
