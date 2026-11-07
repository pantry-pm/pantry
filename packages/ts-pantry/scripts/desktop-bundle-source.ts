import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopBundleSource } from './recipe-types'
import { vendorResponse } from './desktop-version-sources'

/** A changed installer earns native discovery; an unchanged one allocates no Mac. */
export async function archiveFingerprint(source: DesktopBundleSource): Promise<string> {
  const response = await vendorResponse(source.url, { method: 'HEAD', redirect: 'follow' })
  const etag = response.headers.get('etag')
  const modified = response.headers.get('last-modified')
  const size = response.headers.get('content-length')
  if (!etag && !(modified && size)) throw new Error(`No stable installer fingerprint for ${source.url}`)
  return JSON.stringify([response.url, etag, modified, size])
}

/** Read the vendor's real bundle metadata; never invent a version for a rolling download. */
export async function desktopBundleVersion(source: DesktopBundleSource, expectedFingerprint: string): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('Desktop bundle metadata requires macOS')
  if (await archiveFingerprint(source) !== expectedFingerprint) throw new Error('Installer changed since discovery; retry with a fresh update plan')
  const root = mkdtempSync(join(tmpdir(), 'pantry-desktop-version-'))
  const archive = join(root, `installer.${source.format}`)
  const mount = join(root, 'mount')
  let mounted = false
  try {
    execFileSync('curl', ['--fail', '--location', '--retry', '3', '--max-time', '300', source.url, '--output', archive], { stdio: 'ignore' })
    if (await archiveFingerprint(source) !== expectedFingerprint) throw new Error('Installer changed during download')
    let plist: string
    if (source.format === 'dmg') {
      execFileSync('hdiutil', ['attach', archive, '-mountpoint', mount, '-nobrowse', '-readonly', '-quiet'])
      mounted = true
      plist = join(mount, source.bundle, 'Contents/Info.plist')
    }
    else {
      execFileSync('unzip', ['-q', archive, `${source.bundle}/Contents/Info.plist`, '-d', root])
      plist = join(root, source.bundle, 'Contents/Info.plist')
    }
    const version = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${source.versionKey ?? 'CFBundleShortVersionString'}`, plist], { encoding: 'utf8' }).trim()
    if (!/^\d[\w.+-]*$/.test(version)) throw new Error(`Invalid desktop bundle version: ${version}`)
    return version
  }
  finally {
    if (mounted) execFileSync('hdiutil', ['detach', mount, '-quiet'])
    rmSync(root, { recursive: true, force: true })
  }
}
