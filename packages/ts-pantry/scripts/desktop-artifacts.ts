import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function desktopVersionMatches(expected: string, short: string, build: string, pattern?: RegExp): boolean {
  // Vendors sometimes keep the release-build suffix outside the marketing version.
  const normalized = expected.replace(/^v/, '')
  if (pattern) {
    if (!pattern.source.startsWith('^') || !pattern.source.endsWith('$')) throw new Error('Bundle version patterns must match the whole vendor version')
    const match = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).exec(short)
    if (match?.[1] === normalized) return true
  }
  return [short, build, `${short}.${build}`].some(value => value.replace(/^v/, '') === normalized)
    || (normalized.includes('-') && normalized.split('-')[0] === short.replace(/^v/, ''))
}

/** Validate the actual bundle instead of trusting curl's exit status or a bin symlink. */
export function verifyDesktopInstall(prefix: string, expectedVersion: string, platform: string, pattern?: RegExp): void {
  if (!platform.startsWith('darwin-')) return
  const bundles = readdirSync(prefix).filter(name => name.endsWith('.app'))
  if (!bundles.length) throw new Error('Desktop recipe produced no application bundle')
  for (const name of bundles) {
    const bundle = join(prefix, name)
    const plist = join(bundle, 'Contents/Info.plist')
    if (!existsSync(plist)) throw new Error(`${name}: missing Info.plist`)
    const metadata = JSON.parse(execFileSync('python3', ['-c', 'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', plist], { encoding: 'utf8' }))
    if (!desktopVersionMatches(expectedVersion, metadata.CFBundleShortVersionString ?? '', metadata.CFBundleVersion ?? '', pattern)) {
      throw new Error(`${name}: requested ${expectedVersion}, downloaded ${metadata.CFBundleShortVersionString} (${metadata.CFBundleVersion})`)
    }
    const executable = metadata.CFBundleExecutable
    if (typeof executable !== 'string' || !executable || /[/\\]/.test(executable)) throw new Error(`${name}: invalid bundle executable`)
    const path = join(bundle, 'Contents/MacOS', executable)
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0 || !(statSync(path).mode & 0o111)) throw new Error(`${name}: missing executable`)
    const magic = execFileSync('file', ['-bL', path], { encoding: 'utf8' })
    if (!magic.includes('Mach-O') || (platform === 'darwin-arm64' && !magic.includes('arm64'))) throw new Error(`${name}: wrong application architecture: ${magic.trim()}`)
    // Portable archive builds preserve signatures; native builds also verify signed bundles.
    if (process.platform === 'darwin') {
      let signed = true
      try { execFileSync('codesign', ['--display', bundle], { stdio: 'ignore' }) }
      catch { signed = false }
      if (signed) execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' })
    }
  }
}
