/**
 * Desktop App Management for macOS
 *
 * Scans /Applications for installed apps and checks them for updates against
 * pantry's OWN registry (the same desktop-app catalogue we publish) — NO
 * Homebrew. Updating an app re-installs its bundle straight from the registry
 * tarball, mirroring the Zig native-app installer (download → extract → ditto
 * into /Applications → clear quarantine).
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REGISTRY = process.env.PANTRY_REGISTRY_URL || 'https://registry.pantry.dev'

// ── Types ────────────────────────────────────────────────────────

export interface InstalledApp {
  name: string
  version: string
  path: string
  bundleId?: string
}

export interface AppUpdateInfo {
  name: string
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  /** Where the "latest" came from: our registry, the Mac App Store, an Apple
   *  system app, or unknown (not a pantry-published app). */
  source: 'pantry' | 'mas' | 'system' | 'unknown'
  /** pantry domain backing this app, if we publish it. */
  domain: string | null
}

/** One entry of pantry's published desktop-app catalogue. */
export interface DesktopCatalogueEntry {
  domain: string
  label: string
  version: string | null
  platforms?: string[]
}

// ── App name → pantry domain ─────────────────────────────────────
// The catalogue's `label` usually equals the installed `.app` name, but a few
// bundles are named differently than their catalogue label — map those here.
// Key: app name in /Applications (without `.app`). Value: pantry domain.
const NAME_DOMAIN_OVERRIDES: Record<string, string> = {
  'Logi Options+': 'logitech.com/options-plus',
  'logioptionsplus': 'logitech.com/options-plus',
  'Logi Options Plus': 'logitech.com/options-plus',
  'logioptionsplus_installer': 'logitech.com/options-plus',
}

// Known system/Apple apps that pantry doesn't manage.
export const SYSTEM_APPS: Set<string> = new Set([
  'Safari', 'Numbers', 'Pages', 'Keynote', 'GarageBand', 'iMovie', 'Color Picker',
  'Simulator', 'Simulator (Watch)', 'Preview', 'TextEdit', 'Automator', 'Font Book',
  'Migration Assistant', 'Photo Booth', 'System Preferences', 'System Settings',
  'Disk Utility', 'Terminal', 'Activity Monitor', 'Console', 'Grapher', 'Script Editor',
  'Time Machine', 'Photos', 'Mail', 'Calendar', 'Contacts', 'Reminders', 'Notes', 'Maps',
  'Messages', 'FaceTime', 'Books', 'News', 'Stocks', 'Weather', 'Home', 'Podcasts',
  'Music', 'TV', 'Voice Memos', 'Freeform', 'Shortcuts', 'Chess', 'Dictionary',
  'Stickies', 'Image Capture', 'Xcode',
])

// Known Mac App Store apps (updated through the App Store, not pantry).
export const MAS_APPS: Set<string> = new Set([
  'Xcode', 'Numbers', 'Pages', 'Keynote', 'GarageBand', 'iMovie', 'Things3',
  'Grammarly for Safari', 'AdBlock', 'HP Smart', 'Audible', 'Mini Motorways',
  'Snake.io+', 'WhatsApp Messenger', 'Honey', 'Wappalyzer',
])

// ── Utility Functions ────────────────────────────────────────────

/**
 * Compare two version strings. Returns true if `latest` is newer than `current`.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  if (!latest || !current || latest === current) return false
  if (current === '?') return !!latest

  // Normalize: strip build metadata, split on dots
  const normalize = (v: string): number[] =>
    v.replace(/[,+].*/g, '').replace(/-.*$/, '').split('.').map(n => Number.parseInt(n, 10) || 0)

  const a = normalize(latest)
  const b = normalize(current)

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0
    const bv = b[i] || 0
    if (av > bv) return true
    if (av < bv) return false
  }

  return false
}

/** Normalize a name for loose matching (lowercase, strip non-alphanumerics). */
function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// ── Core Functions ───────────────────────────────────────────────

/**
 * Scan /Applications for installed apps and read their versions from Info.plist.
 */
export function scanInstalledApps(applicationsDir = '/Applications'): InstalledApp[] {
  if (process.platform !== 'darwin') return []
  const apps: InstalledApp[] = []

  if (!fs.existsSync(applicationsDir)) return apps

  const entries = fs.readdirSync(applicationsDir).filter(e => e.endsWith('.app'))

  for (const entry of entries) {
    const name = entry.replace(/\.app$/, '')
    const appPath = `${applicationsDir}/${entry}`
    let version = '?'
    let bundleId: string | undefined

    try {
      const plistPath = `${appPath}/Contents/Info.plist`
      if (fs.existsSync(plistPath)) {
        const vOut = execSync(
          `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${plistPath}" 2>/dev/null`,
          { timeout: 5000, encoding: 'utf-8' },
        ).trim()
        if (vOut) version = vOut

        try {
          bundleId = execSync(
            `/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "${plistPath}" 2>/dev/null`,
            { timeout: 5000, encoding: 'utf-8' },
          ).trim() || undefined
        }
        catch {}
      }
    }
    catch {}

    apps.push({ name, version, path: appPath, bundleId })
  }

  return apps
}

/**
 * Fetch pantry's published desktop-app catalogue (domain → label + version).
 * This is the registry's own list — the same one the publish pipeline feeds.
 */
export async function fetchDesktopCatalogue(): Promise<DesktopCatalogueEntry[]> {
  try {
    const res = await fetch(`${REGISTRY}/desktop-apps`)
    if (!res.ok) return []
    const data = await res.json() as any
    const apps = (data.apps ?? data ?? []) as any[]
    return apps
      .filter(a => a && a.domain)
      .map(a => ({ domain: a.domain, label: a.label ?? a.name ?? a.domain, version: a.version ?? null, platforms: a.platforms }))
  }
  catch {
    return []
  }
}

/** Map an installed app name to a pantry domain (override map first, then the
 *  registry catalogue by loose name match). */
function resolveDomain(appName: string, catalogue: DesktopCatalogueEntry[]): DesktopCatalogueEntry | null {
  const override = NAME_DOMAIN_OVERRIDES[appName]
  if (override) {
    const hit = catalogue.find(e => e.domain === override)
    if (hit) return hit
  }
  const n = normName(appName)
  return catalogue.find(e => normName(e.label) === n || normName(e.domain.replace(/\.(com|app|io|net|dev|org|ai|so|rest|fr)$/, '')) === n) ?? null
}

/**
 * Check installed desktop apps for updates against pantry's registry.
 * Scans /Applications, matches each app to a published pantry domain, and
 * compares the installed version with the registry's latest. No Homebrew.
 */
export async function checkAppUpdates(apps?: InstalledApp[]): Promise<AppUpdateInfo[]> {
  const installedApps = apps || scanInstalledApps()
  const catalogue = await fetchDesktopCatalogue()
  const results: AppUpdateInfo[] = []

  for (const app of installedApps) {
    let source: AppUpdateInfo['source'] = 'unknown'
    let latestVersion: string | null = null
    let updateAvailable = false
    let domain: string | null = null

    if (SYSTEM_APPS.has(app.name)) {
      source = 'system'
    }
    else {
      const entry = resolveDomain(app.name, catalogue)
      if (entry) {
        source = 'pantry'
        domain = entry.domain
        latestVersion = entry.version
        updateAvailable = !!latestVersion && isNewerVersion(latestVersion, app.version)
      }
      else if (MAS_APPS.has(app.name)) {
        source = 'mas'
      }
    }

    results.push({
      name: app.name,
      currentVersion: app.version,
      latestVersion,
      updateAvailable,
      source,
      domain,
    })
  }

  // Sort: outdated first, then by name
  results.sort((a, b) => {
    if (a.updateAvailable && !b.updateAvailable) return -1
    if (!a.updateAvailable && b.updateAvailable) return 1
    return a.name.localeCompare(b.name)
  })

  return results
}

/**
 * Update a desktop app by re-installing it from pantry's registry — NO
 * Homebrew. Mirrors the Zig native-app installer: resolve the latest tarball
 * for this arch, download + extract it, then `ditto` the .app into
 * /Applications and clear the quarantine flag.
 */
export async function updateApp(appName: string): Promise<{
  success: boolean
  version?: string
  error?: string
}> {
  if (process.platform !== 'darwin')
    return { success: false, error: 'Desktop app updates are macOS-only' }

  try {
    const catalogue = await fetchDesktopCatalogue()
    const entry = resolveDomain(appName, catalogue)
    if (!entry)
      return { success: false, error: `"${appName}" is not a pantry-published desktop app` }

    const domain = entry.domain
    const metaRes = await fetch(`${REGISTRY}/binaries/${encodeURI(domain)}/metadata.json`)
    if (!metaRes.ok)
      return { success: false, error: `no registry metadata for ${domain}` }
    const meta = await metaRes.json() as any
    const version: string = meta.latestVersion
    const arch = os.arch() === 'arm64' ? 'darwin-arm64' : 'darwin-x86-64'
    const platforms = meta.versions?.[version]?.platforms ?? {}
    const pm = platforms[arch] ?? platforms['darwin-arm64'] ?? platforms['darwin-x86-64']
    if (!pm?.tarball)
      return { success: false, error: `no ${arch} build published for ${domain}@${version}` }

    const tarballUrl = `${REGISTRY}/${String(pm.tarball).replace(/^\/?/, '')}`
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-app-'))
    try {
      const archive = path.join(work, 'pkg.tar.gz')
      const dl = await fetch(tarballUrl)
      if (!dl.ok)
        return { success: false, error: `failed to download ${tarballUrl} (${dl.status})` }
      fs.writeFileSync(archive, Buffer.from(await dl.arrayBuffer()))

      const extract = path.join(work, 'x')
      fs.mkdirSync(extract, { recursive: true })
      execSync(`tar -xzf "${archive}" -C "${extract}"`, { timeout: 120000 })

      // Find the .app bundle (shallow) and ditto it into /Applications.
      const findApp = (dir: string, depth: number): string | null => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue
          const full = path.join(dir, e.name)
          if (e.name.endsWith('.app')) return full
          if (depth > 0) {
            const hit = findApp(full, depth - 1)
            if (hit) return hit
          }
        }
        return null
      }
      const srcApp = findApp(extract, 3)
      if (!srcApp)
        return { success: false, error: `tarball for ${domain} contained no .app bundle` }

      const dst = `/Applications/${path.basename(srcApp)}`
      execSync(`rm -rf "${dst}"`, { timeout: 30000 })
      execSync(`ditto "${srcApp}" "${dst}"`, { timeout: 120000 })
      execSync(`xattr -dr com.apple.quarantine "${dst}" 2>/dev/null || true`, { timeout: 30000 })

      return { success: true, version }
    }
    finally {
      try { fs.rmSync(work, { recursive: true, force: true }) }
      catch {}
    }
  }
  catch (err: any) {
    return { success: false, error: (err?.message || 'Update failed').toString().trim().split('\n').pop() }
  }
}
