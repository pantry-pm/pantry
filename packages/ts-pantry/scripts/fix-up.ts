#!/usr/bin/env bun

/**
 * Fix-up — Post-build binary fixing for relocatable packages
 *
 * Ported from brewkit's lib/porcelain/fix-up.ts
 * Ensures built binaries work when installed to any prefix.
 */

import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync, lstatSync, realpathSync, openSync, readSync, closeSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { join, relative, dirname, extname, basename, sep } from 'node:path'
import { bundleRuntimeLibraries, normalizeMachoRuntime, writeRuntimeProvenance, type RuntimePackage } from './native-runtime'
import { isDynamicMachO } from './macho'
import { readElfLoaderPaths } from './audit-elf-rpaths'

/**
 * Run all post-build fix-ups on a package prefix
 */
export async function fixUp(prefix: string, platform: string, skips: string[] = [], runtimeDependencies: RuntimePackage[] = []): Promise<void> {
  const [os] = platform.split('-')
  const osName = os === 'darwin' ? 'darwin' : 'linux'
  const originalModes = new Map<string, number>()
  const nativeFiles = new Set<string>()
  const isBinary = osName === 'linux' ? isDynamicElf : isDynamicMachO
  const prepareBinary = (file: string): void => {
    const actual = realpathSync(file)
    nativeFiles.add(actual)
    const mode = statSync(actual).mode & 0o7777
    if (!(mode & 0o200)) {
      originalModes.set(actual, mode)
      chmodSync(actual, mode | 0o200)
    }
  }
  try {
    for (const part of ['bin', 'sbin', 'lib', 'lib64', 'libexec']) {
      const directory = join(prefix, part)
      if (!existsSync(directory) || !lstatSync(directory).isDirectory()) continue
      walkFiles(directory, (file) => {
        if (!isBinary(file)) return
        prepareBinary(file)
      })
    }
    console.log(`\nRunning post-build fix-ups on ${prefix}...`)

    const bundled = (() => {
      try { return bundleRuntimeLibraries(prefix, platform, runtimeDependencies, isBinary, 'patchelf', { preserveInternalLayout: skips.includes(osName === 'linux' ? 'fix-patchelf' : 'fix-machos'), prepareBinary }) }
      catch (cause) { throw new Error(`Cannot normalize ${osName === 'linux' ? 'ELF loader paths' : 'Mach-O runtime libraries'}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }) }
    })()
    if (osName === 'darwin' && !skips.includes('fix-machos')) normalizeMachoRuntime(prefix, isDynamicMachO, [...nativeFiles])
    else if (osName === 'linux' && !skips.includes('fix-patchelf')) fixElfRpaths(prefix, 'patchelf', [...nativeFiles])
    if (osName === 'linux') {
      const vendored = fixVendoredElfRpaths(prefix)
      if (vendored.length) console.log(`  Dropped broken loader path entries from ${vendored.length} vendored ELF file(s)`)
    }
    writeRuntimeProvenance(prefix, bundled)

    // Fix pkg-config files
    fixPkgConfigFiles(prefix)

    // Fix cmake files
    fixCmakeFiles(prefix)

    // Remove libtool .la files
    if (!skips.includes('libtool-cleanup')) {
      removeLaFiles(prefix)
    }

    console.log('Fix-ups complete.')
  }
  finally {
    for (const [file, mode] of originalModes) if (existsSync(file)) chmodSync(file, mode)
  }
}
export function fixElfRpaths(prefix: string, patchelf = 'patchelf', additionalFiles: readonly string[] = []): void {
  const dirs = ['bin', 'sbin', 'lib', 'lib64', 'libexec'].filter(dir => existsSync(join(prefix, dir)) && lstatSync(join(prefix, dir)).isDirectory())
  const root = realpathSync(prefix)
  const visited = new Set<string>()
  const normalize = (filePath: string): void => {
    if (!isDynamicElf(filePath)) return
    const actual = realpathSync(filePath)
    if (visited.has(actual)) return
    visited.add(actual)
    try {
      const existing = execFileSync(patchelf, ['--print-rpath', filePath], { encoding: 'utf8' }).trim().split(':')
      const libraries = relative(root, actual).split(sep)[0] === 'lib64' ? ['lib64', 'lib'] : ['lib', 'lib64']
      const paths = new Set(libraries.filter(lib => existsSync(join(root, lib))).map((lib) => {
        const up = relative(dirname(actual), join(root, lib)).split(sep).join('/')
        return up ? `$ORIGIN/${up}` : '$ORIGIN'
      }))
      // The package's own libraries must precede dependency and host paths.
      for (const path of existing) {
        if (!/^\$(?:ORIGIN|\{ORIGIN\})(?:\/|$)/.test(path)) continue
        // Mirrored artifacts can name a managed dependency's versioned
        // prefix rather than its library directory. ELF loaders do not
        // descend into lib automatically; preserve the dependency and make
        // its canonical library locations explicit before publication.
        if (/\/v\d[\w.+-]*$/.test(path)) {
          paths.add(`${path}/lib`)
          paths.add(`${path}/lib64`)
        }
        paths.add(path)
      }
      const expected = [...paths].join(':')
      applyElfRpath(filePath, expected, patchelf)
      if (execFileSync(patchelf, ['--print-rpath', filePath], { encoding: 'utf8' }).trim() !== expected)
        throw new Error('rewritten loader path did not match')
    }
    catch (cause) {
      throw new Error(`Cannot normalize ELF loader paths for ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}; a working patchelf is required before publication`, { cause })
    }
  }
  for (const dir of dirs) walkFiles(join(prefix, dir), normalize)
  for (const file of additionalFiles) {
    const actual = realpathSync(file)
    if (actual !== root && !actual.startsWith(root + sep)) throw new Error('Native runtime resource escapes artifact')
    normalize(file)
  }
}

/** The directories fixElfRpaths owns; the rest of the tree is vendored. */
const NORMALIZED_ELF_DIRS = ['bin', 'sbin', 'lib', 'lib64', 'libexec']

/**
 * A vendored loader path without the entries that search where they should
 * not: an empty entry (the working directory), a relative one (resolved
 * against the working directory) and an `$ORIGIN` expanded away (`/../lib`,
 * so `/lib`). Sound entries keep their order. Null when nothing changes; an
 * empty string when nothing is left.
 */
export function vendoredLoaderPath(value: string): string | null {
  // patchelf prints nothing for a file without RPATH or RUNPATH.
  if (value === '') return null
  const entries = value.split(':')
  const kept = entries.filter(entry => entry !== ''
    && entry !== '/..' && !entry.startsWith('/../')
    && (entry.startsWith('/') || /^\$(?:\{)?(?:ORIGIN|LIB|PLATFORM)(?:\})?(?:\/|$)/.test(entry)))
  return kept.length === entries.length ? null : kept.join(':')
}

/**
 * Vendored ELF files elsewhere in the package tree: Python wheels under
 * `venv/`, npm prebuilts under `node_modules/`, any upstream binary outside
 * the directories fixElfRpaths rewrites. Their layouts are their own, so
 * only the broken entries are dropped (the tag, RPATH or RUNPATH, stays),
 * and a file whose loader path is sound is not touched at all. Runs even
 * where a recipe skips fix-patchelf: an entry that searches the working
 * directory is a hazard whatever else the recipe preserves. Returns the
 * files it rewrote.
 */
export function fixVendoredElfRpaths(prefix: string, patchelf = 'patchelf'): string[] {
  const rewritten: string[] = []
  if (!existsSync(prefix)) return rewritten
  const root = realpathSync(prefix)
  const visit = (filePath: string): void => {
    // Vendored trees carry test fixtures and truncated or foreign images; one
    // the loader could never map has no loader path to repair.
    let dynamic = false
    try { dynamic = isDynamicElf(filePath) }
    catch { return }
    if (!dynamic) return
    const actual = realpathSync(filePath)
    if (actual !== root && !actual.startsWith(root + sep)) return
    let existing: string
    try {
      existing = execFileSync(patchelf, ['--print-rpath', filePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    }
    catch {
      console.log(`  ⚠️  patchelf cannot read vendored ${relative(root, actual)}; left as built`)
      return
    }
    const next = vendoredLoaderPath(existing)
    if (next === null) return
    const runpath = elfUsesRunpath(filePath)
    const mode = statSync(filePath).mode & 0o7777
    const lent = (mode & 0o200) === 0
    if (lent) chmodSync(filePath, mode | 0o200)
    try {
      if (next === '') execFileSync(patchelf, ['--remove-rpath', filePath], { stdio: 'pipe' })
      else execFileSync(patchelf, [...(runpath ? [] : ['--force-rpath']), '--set-rpath', next, filePath], { stdio: 'pipe' })
    }
    catch (cause) {
      throw new Error(`Cannot normalize the ELF loader path of vendored ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
    finally {
      if (lent) chmodSync(filePath, mode)
    }
    if (execFileSync(patchelf, ['--print-rpath', filePath], { encoding: 'utf8' }).trim() !== next)
      throw new Error(`Cannot normalize the ELF loader path of vendored ${filePath}: rewritten loader path did not match`)
    rewritten.push(filePath)
  }
  for (const entry of readdirSync(prefix, { withFileTypes: true })) {
    if (NORMALIZED_ELF_DIRS.includes(entry.name)) continue
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) walkFiles(path, visit)
    else if (entry.isFile()) visit(path)
  }
  return rewritten
}

/** Whether the dynamic section names DT_RUNPATH (29) rather than DT_RPATH. */
function elfUsesRunpath(filePath: string): boolean {
  return readElfLoaderPaths(readFileSync(filePath))?.runpath !== undefined
}

/** Read only ELF headers; static executables and object files need no rewrite. */
function isDynamicElf(filePath: string): boolean {
  const file = openSync(filePath, 'r')
  try {
    const header = new Uint8Array(64)
    const length = readSync(file, header, 0, header.length, 0)
    if (length < 4 || header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) return false
    const bits = header[4]
    if ((bits !== 1 && bits !== 2) || (header[5] !== 1 && header[5] !== 2) || length < (bits === 2 ? 64 : 52))
      throw new Error(`Invalid ELF header in ${filePath}`)
    const view = new DataView(header.buffer)
    const little = header[5] === 1
    if (![2, 3].includes(view.getUint16(16, little))) return false
    const offset = bits === 2 ? Number(view.getBigUint64(32, little)) : view.getUint32(28, little)
    const size = view.getUint16(bits === 2 ? 54 : 42, little)
    const count = view.getUint16(bits === 2 ? 56 : 44, little)
    if (count === 0) return false
    if (!Number.isSafeInteger(offset) || offset < (bits === 2 ? 64 : 52) || size < (bits === 2 ? 56 : 32) || count === 0xffff || offset + size * count > statSync(filePath).size)
      throw new Error(`Invalid ELF program headers in ${filePath}`)
    const type = new Uint8Array(4)
    for (let index = 0; index < count; index++) {
      if (readSync(file, type, 0, 4, offset + index * size) !== 4)
        throw new Error(`Truncated ELF program header in ${filePath}`)
      if (new DataView(type.buffer).getUint32(0, little) === 2) return !isDetachedDebugInfo(file, view, bits, little, offset + index * size)
    }
    return false
  }
  finally { closeSync(file) }
}

/**
 * A detached debug file (`objcopy --only-keep-debug`, Julia's `*.so.debug`)
 * keeps the program headers of the image it was split from, PT_DYNAMIC
 * included, but its `.dynamic` section is SHT_NOBITS: the loader paths are not
 * in the file. Nothing loads it and patchelf leaves it untouched, so a rewrite
 * could never be read back. Only that exact shape is excluded: an image whose
 * section table has no SHT_DYNAMIC section and a NOBITS one at the dynamic
 * segment's address. Stripped section tables still count as dynamic.
 */
function isDetachedDebugInfo(file: number, header: DataView, bits: number, little: boolean, dynamicHeader: number): boolean {
  const wide = bits === 2
  const tableOffset = wide ? Number(header.getBigUint64(40, little)) : header.getUint32(32, little)
  const entrySize = header.getUint16(wide ? 58 : 46, little)
  const count = header.getUint16(wide ? 60 : 48, little)
  if (!Number.isSafeInteger(tableOffset) || tableOffset === 0 || count === 0 || entrySize < (wide ? 64 : 40)) return false
  const segment = new Uint8Array(wide ? 24 : 12)
  if (readSync(file, segment, 0, segment.length, dynamicHeader) !== segment.length) return false
  const address = wide ? new DataView(segment.buffer).getBigUint64(16, little) : BigInt(new DataView(segment.buffer).getUint32(8, little))
  const table = new Uint8Array(entrySize * count)
  if (readSync(file, table, 0, table.length, tableOffset) !== table.length) return false
  const sections = new DataView(table.buffer)
  let withoutContents = false
  for (let index = 0; index < count; index++) {
    const type = sections.getUint32(index * entrySize + 4, little)
    if (type === 6) return false
    const sectionAddress = wide ? sections.getBigUint64(index * entrySize + 16, little) : BigInt(sections.getUint32(index * entrySize + 12, little))
    if (type === 8 && sectionAddress === address) withoutContents = true
  }
  return withoutContents
}

export function applyElfRpath(filePath: string, rpath: string, patchelf = 'patchelf'): void {
  // Vendor archives can ship read-only binaries (pkgx's oracle.com/berkeley-db
  // installs bin/* as 0555), and patchelf rewrites in place: "open: Permission
  // denied". Lend the owner write permission for the rewrite, then restore it.
  // A missing file is patchelf's to report.
  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o7777 : 0o644
  const lent = (mode & 0o200) === 0
  if (lent) chmodSync(filePath, mode | 0o200)
  try {
    execFileSync(patchelf, ['--force-rpath', '--set-rpath', rpath, filePath], { stdio: 'pipe' })
  }
  finally {
    if (lent) chmodSync(filePath, mode)
  }
}

/**
 * Fix pkg-config .pc files — replace hardcoded paths with ${pcfiledir}
 * From brewkit's fix_pc_files()
 */
function fixPkgConfigFiles(prefix: string): void {
  for (const part of ['lib', 'lib64', 'share']) {
    const pkgconfigDir = join(prefix, part, 'pkgconfig')
    if (!existsSync(pkgconfigDir)) continue

    const files = readdirSync(pkgconfigDir)
    for (const file of files) {
      if (!file.endsWith('.pc')) continue

      const filePath = join(pkgconfigDir, file)
      try {
        // Ensure we have read/write permissions (some installs like CUPS set restrictive perms)
        try { execSync(`chmod u+rw "${filePath}"`, { stdio: 'pipe' }) }
catch { /* ignore */ }
        const orig = readFileSync(filePath, 'utf-8')
        const relativePath = relative(dirname(filePath), prefix)

        const text = orig.replaceAll(prefix, `\${pcfiledir}/${relativePath}`)

        if (orig !== text) {
          console.log(`  Fixing pkg-config: ${file}`)
          writeFileSync(filePath, text)
        }
      }
catch (err: any) {
        console.log(`  ⚠️  Could not fix pkg-config ${file}: ${err.message}`)
      }
    }
  }
}

/**
 * Fix CMake .cmake files — replace hardcoded paths
 * From brewkit's fix_cmake_files()
 */
function fixCmakeFiles(prefix: string): void {
  const cmakeDir = join(prefix, 'lib', 'cmake')
  if (!existsSync(cmakeDir)) return

  walkFiles(cmakeDir, (filePath) => {
    if (!filePath.endsWith('.cmake')) return

    const orig = readFileSync(filePath, 'utf-8')
    const relativePath = relative(dirname(filePath), prefix)

    const text = orig.replaceAll(prefix, `\${CMAKE_CURRENT_LIST_DIR}/${relativePath}`)

    if (orig !== text) {
      console.log(`  Fixing cmake: ${basename(filePath)}`)
      writeFileSync(filePath, text)
    }
  })
}

/**
 * Remove libtool .la files from lib/ (they contain hardcoded paths)
 * From brewkit's remove_la_files()
 * Only removes top-level lib/*.la — subdirectory .la may be module descriptors
 */
export function removeLaFiles(prefix: string): void {
  const libDir = join(prefix, 'lib')
  if (!existsSync(libDir)) return

  const files = readdirSync(libDir)
  for (const file of files) {
    if (!file.endsWith('.la')) continue
    const filePath = join(libDir, file)
    // libpng installs libpng.la as a link to libpng16.la. Once the target is
    // gone (readdir order decides which comes first) a plain stat throws
    // ENOENT, which failed libpng 1.6.59's linux-arm64 build outright; the
    // dangling link is removed along with what it pointed at.
    const stat = statSync(filePath, { throwIfNoEntry: false })
    if (!stat) {
      if (lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
        console.log(`  Removing .la: ${file} (dangling link)`)
        unlinkSync(filePath)
      }
      continue
    }
    if (stat.isFile()) {
      console.log(`  Removing .la: ${file}`)
      unlinkSync(filePath)
    }
  }
}

// --- Helpers ---

/**
 * Walk files recursively in a directory
 */
function walkFiles(dir: string, callback: (filePath: string) => void): void {
  if (!existsSync(dir)) return

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(fullPath, callback)
    }
else if (entry.isFile()) {
      callback(fullPath)
    }
  }
}
