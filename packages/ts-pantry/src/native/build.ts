import type { Entitlements } from './config'
import process from 'node:process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { insideProject, readNativeAppConfig } from './config'
import { provisionNativeRuntime } from './runtime'

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

export function nativeEntitlementsPlist(entries: Entitlements): string {
  const value = (entry: boolean | string | string[]): string => typeof entry === 'boolean' ? `<${entry}/>` : typeof entry === 'string' ? `<string>${xml(entry)}</string>` : Array.isArray(entry) && entry.every(item => typeof item === 'string') ? `<array>${entry.map(item => `<string>${xml(item)}</string>`).join('')}</array>` : (() => { throw new Error('Unsupported entitlement value') })()
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${Object.entries(entries).map(([key, entry]) => `<key>${xml(key)}</key>${value(entry)}`).join('')}</dict></plist>\n`
}

/** Buddy owns compilation; Pantry supplies the runtime and distribution inputs. */
export interface PreparedNativeAppBuild {
  overrides: {
    craftPath?: string
    output?: string
    macosSigning?: { identity: string, provisioningProfile?: string, entitlements?: string, hardenedRuntime: boolean }
  }
  cleanup: () => void
}

export async function prepareNativeAppBuild(root: string, options: { minimumSystemVersion?: string, target?: string, env?: NodeJS.ProcessEnv } = {}): Promise<PreparedNativeAppBuild> {
  const config = readNativeAppConfig(root)
  const env = options.env ?? process.env
  if (!config) return { overrides: {}, cleanup() {} }
  const craftPath = await provisionNativeRuntime(root, config, options.minimumSystemVersion ?? '13.0', { env })
  const store = env.PANTRY_DISTRIBUTION === 'app-store'
  const entitlements = store ? config.macos?.entitlements?.appStore : config.macos?.entitlements?.direct
  const identity = env.APPLE_SIGNING_IDENTITY
  const profile = env.APPLE_PROVISIONING_PROFILE_PATH || env.APPLE_PROVISIONING_PROFILE
  const directory = mkdtempSync(join(tmpdir(), 'pantry-native-build-'))
  try {
    const entitlementsPath = join(directory, 'entitlements.plist')
    if (entitlements) writeFileSync(entitlementsPath, nativeEntitlementsPlist(entitlements), { mode: 0o600 })
    if (profile && !existsSync(profile)) throw new Error('APPLE_PROVISIONING_PROFILE must name a local profile file')
    if (store && (!identity || !profile || entitlements?.['com.apple.security.app-sandbox'] !== true))
      throw new Error('App Store builds require a signing identity, provisioning profile and sandbox entitlement')
    return {
      overrides: {
        ...(craftPath ? { craftPath } : {}),
        ...(store ? { output: insideProject(root, '.pantry/native/app-store') } : {}),
        ...(identity ? { macosSigning: { identity, ...(profile ? { provisioningProfile: resolve(profile) } : {}), ...(entitlements ? { entitlements: entitlementsPath } : {}), hardenedRuntime: !store } } : {}),
      },
      cleanup() { rmSync(directory, { recursive: true, force: true }) },
    }
  }
  catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export interface NativeArtifact {
  path: string
  appPath?: string
  name: string
  bundleId: string
  version: string
  buildNumber: string
  target: string
  minimumSystemVersion?: string
}

export function recordNativeArtifact(root: string, artifact: NativeArtifact): void {
  insideProject(root, artifact.path)
  const directory = join(root, '.pantry/native')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`)
}

export function readNativeArtifact(root: string): NativeArtifact {
  const artifact = JSON.parse(readFileSync(join(root, '.pantry/native/artifact.json'), 'utf8')) as NativeArtifact
  insideProject(root, artifact.path)
  if (!artifact.name || !artifact.bundleId || !artifact.version || !artifact.buildNumber || !existsSync(artifact.path)) throw new Error('The native build did not produce a complete artifact manifest')
  return artifact
}
