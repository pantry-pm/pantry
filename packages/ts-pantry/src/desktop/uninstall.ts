import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

export interface UserPackageRemovalOptions {
  /** Explicit roots allow isolated filesystem tests, never client-supplied paths. */
  store?: string
  home?: string
  protectedPaths?: readonly string[]
  runningExecutables?: readonly string[]
}
interface Move { path: string, inode: number, device: number }
const within = (path: string, root: string) => path === root || path.startsWith(root + sep)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
export function userPackageStore(): string { return join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'pantry/global') }
export function validManagedDomain(domain: string): boolean {
  return domain.length > 0 && domain.length <= 256 && /^[a-zA-Z0-9@][a-zA-Z0-9@._+/-]*$/.test(domain) && domain.split('/').every(part => part && part !== '.' && part !== '..')
}
async function directory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink()
  }
  catch (error) {
    if (missing(error)) return false
    throw error
  }
}
async function packageVersions(domain: string, store: string): Promise<string[]> {
  if (!validManagedDomain(domain)) throw new Error('Choose a valid Pantry package identifier.')
  const root = join(store, 'packages')
  const path = join(root, domain)
  if (!await directory(path)) return []
  const canonical = await realpath(root)
  if (!within(await realpath(path), canonical)) throw new Error('Package storage leaves the Pantry user directory.')
  const versions: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^v[0-9]/.test(entry.name)) continue
    const version = join(path, entry.name)
    if (!within(await realpath(version), canonical)) throw new Error('Package version leaves the Pantry user directory.')
    versions.push(version)
  }
  return versions
}
export async function isManagedUserPackage(domain: string, options: UserPackageRemovalOptions = {}): Promise<boolean> {
  try { return (await packageVersions(domain, options.store || userPackageStore())).length > 0 }
  catch { return false }
}
const locateSelf = 's=$0\nwhile [ -h "$s" ]; do\n  l=$(readlink "$s")\n  case $l in\n    /*) s=$l ;;\n    *) case $s in */*) s=${s%/*}/$l ;; *) s=$l ;; esac ;;\n  esac\ndone\ncase $s in */*) d=${s%/*} ;; *) d=. ;; esac\n'
async function activationTarget(path: string): Promise<string | null> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return resolve(dirname(path), await readlink(path))
  if (!info.isFile() || info.size > 65536) return null
  const source = await readFile(path, 'utf8')
  for (const prefix of [`#!/bin/sh\n${locateSelf}exec "$d/`, `#!/bin/sh\n${locateSelf}exec bun "$d/`, '#!/bin/sh\nexec "', '#!/bin/sh\nexec bun "']) {
    if (!source.startsWith(prefix)) continue
    const match = source.slice(prefix.length).match(/^([^"\r\n`$]+)"(?: '(?:[^']|'"'"')*')* "\$@"\n$/)
    if (!match) continue
    const target = match[1]!
    return prefix.includes('$d/') ? resolve(dirname(path), target) : isAbsolute(target) ? target : null
  }
  return null
}
async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function appIdentity(path: string): Promise<string> {
  const plist = join(path, 'Contents/Info.plist')
  const info = await lstat(plist)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576) throw new Error('Invalid application manifest.')
  const source = await readFile(plist)
  const xml = source.toString('utf8').match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
  if (xml) return xml
  if (source.subarray(0, 6).toString() === 'bplist' && process.platform === 'darwin') {
    const id = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (id) return id
  }
  // Older bundles without an identifier must have the exact original manifest.
  return createHash('sha256').update(source).digest('hex')
}

/** First-class Pantry Desktop removal: user scope only, never shell commands or name-based system-app deletion. */
export async function uninstallUserPackage(domain: string, options: UserPackageRemovalOptions = {}, output: (text: string) => void = () => {}): Promise<void> {
  const store = options.store || userPackageStore()
  const home = options.home || homedir()
  const versions = await packageVersions(domain, store)
  if (!versions.length) throw new Error('This package is not managed in the Pantry user directory.')
  const canonicalVersions = await Promise.all(versions.map(path => realpath(path)))
  const owned = (path: string) => canonicalVersions.some(version => within(path, version))
  for (const path of options.protectedPaths || []) {
    const target = await realpath(path).catch(() => path)
    if (owned(target)) throw new Error('Pantry is using this package to manage software. Its running package manager cannot uninstall itself.')
  }
  const moves = new Map<string, Move>()
  async function add(path: string) {
    const info = await lstat(path)
    moves.set(path, { path, inode: Number(info.ino), device: Number(info.dev) })
  }
  async function activations(root: string, depth: number) {
    if (!await directory(root)) return
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) {
        if (depth > 0) await activations(path, depth - 1)
        continue
      }
      const target = await activationTarget(path)
      if (target && (owned(await realpath(target).catch(() => target)))) await add(path)
    }
  }
  for (const name of ['bin', 'sbin', 'lib', 'libexec', 'include', 'share']) await activations(join(store, name), 8)
  const assets = new Map<string, { sources: string[], app: boolean, root: string }>()
  async function payload(root: string, depth: number) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const source = join(root, entry.name)
      const app = entry.isDirectory() && /\.app$/i.test(entry.name)
      const font = entry.isFile() && /\.(?:otf|ttf|ttc)$/i.test(entry.name)
      if (app || font) {
        const destinationRoot = app ? join(home, 'Applications') : join(home, 'Library/Fonts')
        const destination = join(destinationRoot, entry.name)
        const previous = assets.get(destination)
        if (previous) previous.sources.push(source)
        else assets.set(destination, { sources: [source], app, root: destinationRoot })
      }
      else if (entry.isDirectory() && depth > 0) await payload(source, depth - 1)
    }
  }
  for (const version of versions) await payload(version, 4)
  for (const [destination, asset] of assets) {
    let info
    try { info = await lstat(destination) }
    catch (error) {
      if (missing(error)) continue
      throw error
    }
    if (info.isSymbolicLink() || (asset.app ? !info.isDirectory() : !info.isFile())) throw new Error(`Refusing to remove a replaced file: ${destination}`)
    if (!within(await realpath(destination), await realpath(asset.root))) throw new Error('An activated file leaves its user directory.')
    if (asset.app) {
      const running = options.runningExecutables || (process.platform === 'darwin' ? execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 5000, maxBuffer: 4194304 }).split('\n').map(line => line.trim()) : [])
      if (running.some(path => within(path, destination))) throw new Error(`Quit ${basename(destination, '.app')} before uninstalling it.`)
    }
    const identity = asset.app ? await appIdentity(destination) : await fileHash(destination)
    let matches = false
    for (const source of asset.sources) {
      if ((asset.app ? await appIdentity(source) : await fileHash(source)) === identity) {
        matches = true
        break
      }
    }
    if (!matches) throw new Error(`The installed file differs from this Pantry package; it was kept: ${destination}`)
    await add(destination)
  }
  // Version aliases belong to this package, but nested package namespaces do not.
  const domainRoot = join(store, 'packages', domain)
  for (const entry of await readdir(domainRoot, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue
    const path = join(domainRoot, entry.name)
    const target = await activationTarget(path)
    if (target && owned(await realpath(target).catch(() => target))) await add(path)
  }
  for (const version of versions) await add(version)
  const trash = join(home, '.Trash')
  await mkdir(trash, { recursive: true, mode: 0o700 })
  if (!await directory(trash)) throw new Error('The user Trash must be a real directory.')
  const recovery = await mkdtemp(join(trash, 'Pantry-'))
  const completed: { from: string, to: string }[] = []
  try {
    for (const [index, move] of [...moves.values()].entries()) {
      const current = await lstat(move.path)
      if (Number(current.ino) !== move.inode || Number(current.dev) !== move.device) throw new Error('A managed file changed while preparing removal. Retry uninstall.')
      const container = join(recovery, String(index))
      await mkdir(container, { mode: 0o700 })
      const to = join(container, basename(move.path))
      await rename(move.path, to)
      completed.push({ from: move.path, to })
    }
  }
  catch (error) {
    for (const move of completed.reverse()) {
      try { await rename(move.to, move.from) }
      catch { output(`A file could not be restored. Recovery folder: ${recovery}\n`) }
    }
    throw error
  }
  await rmdir(domainRoot).catch(() => {})
  output(`Uninstalled ${domain}. Managed files moved to ${recovery}. App data and other packages were kept.\n`)
}
