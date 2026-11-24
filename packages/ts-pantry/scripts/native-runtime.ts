import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

export interface RuntimePackage { domain: string, version: string, prefix: string, resources?: string[] }
export interface RuntimeResourceReceipt { path: string, sha256: string }
export interface RuntimeLibraryReceipt { name: string, domain: string, version: string, source: string, sourceSha256: string, licenseFiles: string[], resources?: RuntimeResourceReceipt[] }
interface RuntimeLibraryCandidate { file: string, dependency?: RuntimePackage, bundledOrigin?: RuntimeLibraryReceipt & { bundledSha256: string } }

/** Libraries every supported Linux host provides itself (glibc, musl, libstdc++, libgcc_s). */
export const linuxStandardLibraries: RegExp = /^(?:lib(?:c|m|dl|pthread|rt|resolv|util|anl)\.so\.[0-9]+|libstdc\+\+\.so\.6|libgcc_s\.so\.1|ld-linux[^/]*\.so\.[0-9]+|ld-musl[^/]*\.so\.[0-9]+)$/
/**
 * GPU driver entry points the host's driver installation must supply, matched
 * to its kernel module: the Vulkan and OpenCL ICD loaders and NVIDIA's driver
 * libraries. A package cannot bundle them, so a vendored binary that links one
 * (node-llama-cpp's Vulkan and CUDA builds) needs nothing declared for it.
 */
export const linuxHostDriverLibraries: RegExp = /^(?:libvulkan\.so\.1|libOpenCL\.so\.1|libcuda\.so\.1|libnvidia-ml\.so\.1|libnvcuvid\.so\.1|libnvidia-encode\.so\.1)$/
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep)

/**
 * The name a linker resolves `-l<name>` through for a runtime library file:
 * `libintl.8.dylib` → `libintl.dylib`, `libgettextlib-0.26.dylib` →
 * `libgettextlib.dylib`, `libz.so.1.3` → `libz.so`.
 */
export function linkTimeLibraryName(name: string): string {
  const elf = /^(lib.+?)\.so(?:\.[\d.]+)?$/.exec(name)
  if (elf) return `${elf[1]}.so`
  const macho = /^(lib.+?)(?:[-.]\d[\d.]*)?\.dylib$/.exec(name)
  if (macho) return `${macho[1]}.dylib`
  return name
}

/** The current version in a Mach-O library's LC_ID_DYLIB, or null without one. */
export function machoCurrentVersion(file: string): string | null {
  const commands = execFileSync('otool', ['-l', file], { encoding: 'utf8' })
  return /cmd LC_ID_DYLIB[\s\S]*?current version ([\d.]+)/.exec(commands)?.[1] ?? null
}

/** The file name in a Mach-O library's install name (LC_ID_DYLIB), or null. */
export function machoInstallBasename(file: string): string | null {
  const id = execFileSync('otool', ['-D', file], { encoding: 'utf8' }).trim().split('\n')[1]?.trim()
  return id ? basename(id) : null
}

/** Dotted-version comparison as dyld applies it; an unknown version passes. */
export function versionAtLeast(version: string | null, minimum: string): boolean {
  if (!version) return true
  const have = version.split('.').map(Number)
  const want = minimum.split('.').map(Number)
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const a = have[i] ?? 0
    const b = want[i] ?? 0
    if (a !== b) return a > b
  }
  return true
}

/**
 * True when `file`'s package ships the link-time name for it, resolving to
 * this very file: the package is a library a binary can have been linked
 * against with `-l`. A runtime copy bundled into another package's lib/
 * carries only the versioned file.
 */
export function shipsLinkTimeName(file: string): boolean {
  const name = basename(file)
  const linkName = linkTimeLibraryName(name)
  // An unversioned file is its own link-time name, wherever it was copied.
  if (linkName === name) return true
  try {
    return realpathSync(join(dirname(file), linkName)) === realpathSync(file)
  }
  catch {
    return false
  }
}

/** Preserve recipe-owned library data at the same relative path in its new artifact. */
export function copyRuntimeResources(prefix: string, dependency: RuntimePackage): RuntimeResourceReceipt[] {
  const root = realpathSync(prefix)
  const owner = realpathSync(dependency.prefix)
  const receipts: RuntimeResourceReceipt[] = []
  const parents = (directory: string): void => {
    if (!inside(root, directory)) throw new Error('Runtime resource destination escapes artifact')
    if (directory === root) return
    parents(dirname(directory))
    const entry = lstatMaybe(directory)
    if (entry) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Unsafe runtime resource destination: ${directory}`)
    }
    else mkdirSync(directory)
  }
  const copy = (source: string, destination: string, ancestors: Set<string>): void => {
    const actual = realpathSync(source)
    if (!inside(owner, actual)) throw new Error(`Runtime resource escapes declared package ${dependency.domain}: ${source}`)
    const stat = statSync(actual)
    if (stat.isDirectory()) {
      if (ancestors.has(actual)) throw new Error(`Cyclic runtime resource: ${source}`)
      parents(destination)
      const next = new Set([...ancestors, actual])
      for (const name of readdirSync(actual).sort()) copy(join(actual, name), join(destination, name), next)
    }
    else if (stat.isFile()) {
      parents(dirname(destination))
      const sha256 = hash(actual)
      const entry = lstatMaybe(destination)
      if (entry) {
        if (entry.isSymbolicLink() || !entry.isFile() || hash(destination) !== sha256)
          throw new Error(`Conflicting runtime resource: ${relative(root, destination)}`)
      }
      else {
        copyFileSync(actual, destination)
        chmodSync(destination, stat.mode & 0o777)
      }
      receipts.push({ path: relative(root, destination).split(sep).join('/'), sha256 })
    }
    else throw new Error(`Unsupported runtime resource: ${source}`)
  }
  for (const resource of dependency.resources ?? []) {
    if (!resource || isAbsolute(resource) || resource.includes('\\') || resource.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error(`Invalid runtime resource path: ${resource}`)
    copy(join(owner, resource), join(root, resource), new Set())
  }
  return receipts
}

function lstatMaybe(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function walk(directory: string, visit: (file: string) => void): void {
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.endsWith('.app')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path, visit)
    else if (entry.isFile()) visit(path)
    else if (entry.isSymbolicLink()) {
      let target: ReturnType<typeof statSync>
      try { target = statSync(path) }
      catch (error) {
        // Configuration links may name files created only on an installed host.
        // Index available providers; a missing DT_NEEDED library still fails
        // resolution below, and explicitly declared resources remain strict.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        continue
      }
      if (target.isFile()) visit(path)
    }
  }
}

function preserveLicenses(prefix: string, dependency: RuntimePackage): string[] {
  const files: string[] = []
  const root = realpathSync(dependency.prefix)
  const copy = (source: string): void => {
    if (!inside(root, realpathSync(source))) throw new Error(`License escapes declared runtime package ${dependency.domain}`)
    const name = relative(root, source)
    if (!/(?:^|\/)(?:licen[sc]e|copying|copyright|notice)(?:[.\-_].*)?$/i.test(name)) return
    const destination = join(prefix, 'share/licenses/pantry-runtime', encodeURIComponent(`${dependency.domain}@${dependency.version}`), name)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
    files.push(relative(prefix, destination).split(sep).join('/'))
  }
  for (const file of readdirSync(root, { withFileTypes: true })) if (file.isFile()) copy(join(root, file.name))
  for (const folder of ['share/licenses', 'share/doc']) walk(join(root, folder), copy)
  return files
}

/** Copy the actual recursively required SONAMEs from declared runtime packages only. */
/**
 * `name` as `file`'s own `$ORIGIN`-relative RPATH/RUNPATH would find it,
 * when that is a file inside `root`; otherwise undefined.
 */
export function originSibling(root: string, file: string, name: string, patchelf = 'patchelf'): string | undefined {
  let loaderPath: string
  try {
    loaderPath = execFileSync(patchelf, ['--print-rpath', file], { encoding: 'utf8' }).trim()
  }
  catch {
    return undefined
  }
  for (const entry of loaderPath.split(':')) {
    const match = /^\$(?:ORIGIN|\{ORIGIN\})(\/.*)?$/.exec(entry)
    if (!match) continue
    const candidate = join(dirname(file), match[1] ?? '', name)
    if (!existsSync(candidate)) continue
    const actual = realpathSync(candidate)
    if (inside(root, actual)) return actual
  }
  return undefined
}

/**
 * A file a language package manager installed (npm's node_modules, pip's
 * site-packages): its optional platform variants are chosen at run time.
 */
export function vendoredByPackageManager(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some(part => part === 'node_modules' || part === 'site-packages' || part === 'dist-packages')
}

export function bundleRuntimeLibraries(
  prefix: string,
  platform: string,
  dependencies: RuntimePackage[],
  isBinary: (file: string) => boolean,
  patchelf = 'patchelf',
  options: { preserveInternalLayout?: boolean, prepareBinary?: (file: string) => void } = {},
): RuntimeLibraryReceipt[] {
  const linux = platform.startsWith('linux-')
  const root = realpathSync(prefix)
  const index = new Map<string, RuntimeLibraryCandidate[]>()
  const queue: string[] = []
  const receipts: RuntimeLibraryReceipt[] = []
  const licenses = new Map<string, string[]>()
  const resources = new Map<string, RuntimeResourceReceipt[]>()
  const register = (directory: string, dependency?: RuntimePackage): void => {
    const owner = realpathSync(directory)
    const manifest = join(owner, 'share/pantry/runtime-libraries.json')
    const bundled: Array<RuntimeLibraryReceipt & { bundledSha256: string }> = dependency && existsSync(manifest)
      ? JSON.parse(readFileSync(manifest, 'utf8')).libraries
      : []
    for (const part of ['lib', 'lib64']) walk(join(owner, part), (file) => {
      const actual = realpathSync(file)
      if (!inside(owner, actual)) throw new Error(`Library escapes declared runtime package: ${file}`)
      if (!isBinary(actual)) return
      // A dependency can already carry a normalized copy of another declared
      // package. Loader-path rewrites change its hash without creating a new
      // provider. Verify its recorded bytes before resolving its origin against
      // the complete current dependency cohort below.
      const receipt = bundled.find(library => actual === join(owner, 'lib', library.name))
      if (receipt) {
        if (hash(actual) !== receipt.bundledSha256) throw new Error(`Invalid bundled runtime provenance for ${receipt.name}`)
        if (isAbsolute(receipt.source) || receipt.source.includes('\\') || receipt.source.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(receipt.sourceSha256))
          throw new Error(`Invalid canonical runtime provenance for ${receipt.name}`)
      }
      const entries = index.get(basename(file)) || []
      if (!entries.some(entry => entry.file === actual)) entries.push({ file: actual, dependency, bundledOrigin: receipt })
      index.set(basename(file), entries)
    })
  }
  register(root)
  for (const dependency of dependencies) register(dependency.prefix, dependency)
  // A receipt names the package that originally supplied a bundled copy, not
  // a second provider. Resolve the requested ABI name against that owner's
  // currently declared package, including compatible version upgrades whose
  // physical filenames differ. Gather the full cohort first so order cannot
  // change selection. Unrelated providers still collide and fail below.
  for (const [name, candidates] of index) {
    index.set(name, candidates.filter((candidate) => {
      const origin = candidate.bundledOrigin
      return !origin || !candidates.some(canonical => !canonical.bundledOrigin && canonical.dependency?.domain === origin.domain)
    }))
  }
  for (const part of ['bin', 'sbin', 'lib', 'lib64', 'libexec']) walk(join(root, part), (file) => {
    if (!lstatSync(file).isSymbolicLink() && isBinary(file)) queue.push(file)
  })
  const visited = new Set<string>()
  const copiedFrom = new Map<string, string>()
  // The dependency each bundled copy came from. Its own lib/ holds the closure
  // it was built and normalized with, so its needs resolve there first.
  const copiedOwner = new Map<string, RuntimePackage>()
  const missing = new Set<string>()
  const vendoredUnresolved = new Set<string>()
  for (let position = 0; position < queue.length; position++) {
    const file = queue[position]
    if (visited.has(file)) continue
    visited.add(file)
    options.prepareBinary?.(file)
    // Mach-O load commands record the compatibility version the client was
    // linked against; a provider older than that is not the one it linked.
    const requiredCompatibility = new Map<string, string>()
    const needed = linux
      ? execFileSync(patchelf, ['--print-needed', file], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
      // Load commands are the indented lines. A universal image prints one
      // unindented `<file> (architecture <arch>):` header per slice, and
      // dropping only the first line read the later headers as the image
      // depending on itself.
      : [...new Set(execFileSync('otool', ['-L', file], { encoding: 'utf8' }).split('\n').filter(line => /^\s/.test(line)).map((line) => {
          const name = line.trim().replace(/\s+\(.*$/, '')
          const compatibility = /\(compatibility version ([\d.]+)/.exec(line)?.[1]
          if (name && compatibility) requiredCompatibility.set(name, compatibility)
          return name
        }).filter(Boolean))]
    const ownInstallName = linux ? undefined : execFileSync('otool', ['-D', file], { encoding: 'utf8' }).trim().split('\n')[1]?.trim()
    for (const dependencyName of needed) {
      if (dependencyName === ownInstallName) continue
      if (!linux && (dependencyName.startsWith('/usr/lib/') || dependencyName.startsWith('/System/Library/'))) continue
      const name = basename(dependencyName)
      let candidates = index.get(name) || []
      if (candidates.length === 0 && linux && (linuxStandardLibraries.test(name) || linuxHostDriverLibraries.test(name))) continue
      // A vendored binary (an npm prebuilt such as sharp's .node beside its
      // libvips package) finds its siblings through its own $ORIGIN loader
      // path, inside this artifact. The loader resolves those; so do we, and
      // check what they need in turn, leaving the vendor's layout as it is.
      const sibling = candidates.length === 0 && linux ? originSibling(root, file, name, patchelf) : undefined
      if (sibling) {
        queue.push(sibling)
        continue
      }
      if (candidates.length === 0 && vendoredByPackageManager(relative(root, file))) {
        // npm and pip install every platform's optional prebuilt (musl
        // builds, GPU builds) and load only the one the host can run; what a
        // variant needs beyond this artifact is not this package's to declare.
        vendoredUnresolved.add(`${dependencyName} (${relative(root, file)})`)
        continue
      }
      if (candidates.length === 0) {
        missing.add(`Undeclared or missing runtime library ${dependencyName} required by ${relative(root, file)}`)
        continue
      }
      // Two versions of one library can both be declared (libxml2 2.13.9 for
      // a pkgx-built dependency beside php's 2.15.4) and both answer to the
      // link-time name. dyld loads a library only if its current version is
      // at least the compatibility version the client recorded, so a provider
      // below it was never the library this binary linked.
      const required = requiredCompatibility.get(dependencyName)
      if (!linux && required && candidates.length > 1) {
        const compatible = candidates.filter(candidate => inside(root, candidate.file) || versionAtLeast(machoCurrentVersion(candidate.file), required))
        if (compatible.length) candidates = compatible
      }
      // A library copied from dependency P needs what P's own install loads
      // through @loader_path: thrysoee.dk/editline's libedit carries the
      // libncursesw.6.dylib (with tgetent) it was linked against, while the
      // separately declared ncurses keeps tgetent in libtinfow.
      const owner = copiedOwner.get(file)
      if (owner && candidates.length > 1) {
        const ownerPrefix = realpathSync(owner.prefix)
        const own = candidates.filter(candidate => candidate.dependency && realpathSync(candidate.dependency.prefix) === ownerPrefix)
        if (own.length) candidates = own
      }
      let selected = candidates.find(candidate => inside(root, candidate.file)) || candidates[0]
      if (!inside(root, selected.file) && candidates.some(candidate => hash(candidate.file) !== hash(selected.file))) {
        // Older artifacts carry runtime copies of other packages' libraries
        // with no provenance receipt: gnu.org/bison, sed and m4 on darwin each
        // ship a libintl.8.dylib beside the gettext that owns it. A binary
        // links a library through its link-time name (-lintl → libintl.dylib),
        // which only the owning package ships, so when the linkable candidates
        // agree on one identity that is the library the binary was linked
        // against. No linkable candidate, or several that differ, still conflict.
        const owners = candidates.filter(candidate => shipsLinkTimeName(candidate.file))
        if (!owners.length || owners.some(owner => hash(owner.file) !== hash(owners[0].file)))
          throw new Error(`Conflicting declared runtime providers for ${name}: ${candidates.map(candidate => `${candidate.dependency?.domain}@${candidate.dependency?.version} (${candidate.file}, sha256 ${hash(candidate.file)})`).join('; ')}`)
        selected = owners[0]
      }
      // A vendor runtime can load the same internal library both through its
      // linker and dlopen. Flattening it creates a second identity (notably a
      // second JVM). Honor the recipe's preserved loader layout while still
      // resolving every recursively needed provider from the owned artifact.
      if (options.preserveInternalLayout && inside(root, selected.file)) {
        queue.push(selected.file)
        continue
      }
      // A Mach-O copy is named after the provider's install name, its ABI
      // name, so every client that reaches one library (php through the
      // link-time name libxml2.dylib, libxslt through libxml2.16.dylib) shares
      // one image instead of loading two copies of it. ELF clients find a
      // library by its DT_NEEDED name, which is already the soname.
      const bundledName = !linux && !inside(root, selected.file) ? machoInstallBasename(selected.file) ?? name : name
      const destination = join(root, 'lib', bundledName)
      mkdirSync(dirname(destination), { recursive: true })
      const earlier = copiedFrom.get(bundledName)
      if (earlier && hash(earlier) !== hash(selected.file))
        throw new Error(`Conflicting declared runtime providers for ${bundledName}: ${earlier} and ${selected.file}`)
      if (!existsSync(destination)) {
        copyFileSync(selected.file, destination)
        chmodSync(destination, 0o755)
        if (!inside(root, selected.file)) copiedFrom.set(bundledName, selected.file)
        if (selected.dependency) copiedOwner.set(destination, selected.dependency)
        if (selected.dependency) {
          const identity = `${selected.dependency.domain}@${selected.dependency.version}`
          if (!licenses.has(identity)) licenses.set(identity, preserveLicenses(root, selected.dependency))
          if (!resources.has(identity)) {
            const copied = copyRuntimeResources(root, selected.dependency)
            resources.set(identity, copied)
            // Resources can be native helpers or loadable modules with their
            // own library edges, rather than only passive data files.
            for (const resource of copied) {
              const file = join(root, resource.path)
              if (isBinary(file)) queue.push(file)
            }
          }
          receipts.push({ name: bundledName, domain: selected.dependency.domain, version: selected.dependency.version, source: relative(realpathSync(selected.dependency.prefix), selected.file).split(sep).join('/'), sourceSha256: hash(selected.file), licenseFiles: licenses.get(identity)!, resources: resources.get(identity)! })
        }
      }
      else if (!inside(root, realpathSync(destination))) throw new Error(`Bundled runtime library escapes artifact: ${bundledName}`)
      queue.push(destination)
      if (linux && dependencyName !== name)
        execFileSync(patchelf, ['--replace-needed', dependencyName, name, file], { stdio: 'pipe' })
      if (!linux && dependencyName !== `@rpath/${bundledName}`)
        execFileSync('install_name_tool', ['-change', dependencyName, `@rpath/${bundledName}`, file], { stdio: 'pipe' })
    }
  }
  if (missing.size) throw new Error([...missing].join('; '))
  if (vendoredUnresolved.size)
    console.log(`  Left ${vendoredUnresolved.size} library need(s) of package-manager prebuilts to the host or another platform: ${[...vendoredUnresolved].slice(0, 5).join('; ')}${vendoredUnresolved.size > 5 ? '; ...' : ''}`)
  return receipts
}

/**
 * The entitlements a binary was signed with, as an XML plist, or null when it
 * is unsigned or has none. Readable even after `install_name_tool` has
 * invalidated the signature: the signature blob is still embedded.
 */
export function machoEntitlements(file: string): string | null {
  try {
    const xml = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return xml.includes('<plist') && xml.includes('<key>') ? xml : null
  }
  catch {
    return null
  }
}

/**
 * Ad-hoc re-signs a Mach-O file, keeping the entitlements it was signed with.
 * A plain `codesign --force --sign -` drops them, which breaks software that
 * needs them at runtime: lima's limactl loses
 * com.apple.security.virtualization (its VMs fail to start) and qemu loses
 * com.apple.security.hypervisor (HVF acceleration is refused).
 */
export function resignPreservingEntitlements(file: string): void {
  const entitlements = machoEntitlements(file)
  if (!entitlements) {
    execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'pipe' })
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'pantry-entitlements-'))
  try {
    const plist = join(dir, 'entitlements.plist')
    writeFileSync(plist, entitlements)
    execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', plist, file], { stdio: 'pipe' })
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Normalize loader paths without searching or copying any host libraries. */
export function normalizeMachoRuntime(prefix: string, isBinary: (file: string) => boolean, additionalFiles: readonly string[] = []): void {
  const root = realpathSync(prefix)
  const visited = new Set<string>()
  const normalize = (file: string): void => {
    if (lstatSync(file).isSymbolicLink() || !isBinary(file)) return
    const actual = realpathSync(file)
    if (visited.has(actual)) return
    visited.add(actual)
    let changed = false
    const commands = execFileSync('otool', ['-l', file], { encoding: 'utf8' })
    const existing = [...commands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g)].map(match => match[1])
    const wanted = ['lib', 'lib64'].filter(lib => existsSync(join(root, lib))).map((lib) => {
      const path = relative(dirname(actual), join(root, lib)).split(sep).join('/')
      return path ? `@loader_path/${path}` : '@loader_path'
    })
    for (const path of new Set(existing)) if (!wanted.includes(path)) {
      execFileSync('install_name_tool', ['-delete_rpath', path, file], { stdio: 'pipe' })
      changed = true
    }
    for (const path of wanted) if (!existing.includes(path)) {
      execFileSync('install_name_tool', ['-add_rpath', path, file], { stdio: 'pipe' })
      changed = true
    }
    const id = execFileSync('otool', ['-D', file], { encoding: 'utf8' }).trim().split('\n')[1]?.trim()
    const wantedId = `@rpath/${basename(file)}`
    if (id && id !== wantedId) {
      execFileSync('install_name_tool', ['-id', wantedId, file], { stdio: 'pipe' })
      changed = true
    }
    if (!changed) {
      // Dependency bundling can already have invalidated this signature before
      // normalization. Preserve valid images, while still signing those edits
      // and unsigned compiler output. Tool failures must not look like unsigned.
      try {
        execFileSync('codesign', ['--verify', '--strict', file], { stdio: 'pipe' })
        return
      }
      catch (error) {
        const status = (error as { status?: number | null }).status
        if (typeof status !== 'number' || !Number.isInteger(status) || status <= 0) throw error
      }
    }
    resignPreservingEntitlements(file)
  }
  for (const part of ['bin', 'sbin', 'lib', 'lib64', 'libexec']) walk(join(prefix, part), normalize)
  for (const file of additionalFiles) {
    if (!inside(root, realpathSync(file))) throw new Error('Native runtime resource escapes artifact')
    normalize(file)
  }
}

export function writeRuntimeProvenance(prefix: string, libraries: RuntimeLibraryReceipt[]): void {
  if (!libraries.length) return
  const destination = join(prefix, 'share/pantry/runtime-libraries.json')
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, JSON.stringify({ version: 1, libraries: libraries.map(library => ({
    ...library,
    bundledSha256: hash(join(prefix, 'lib', library.name)),
    resources: library.resources?.map(resource => ({ ...resource, sha256: hash(join(prefix, resource.path)) })),
  })) }, null, 2) + '\n')
}
