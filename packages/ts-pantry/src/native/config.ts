import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export type Entitlements = Record<string, boolean | string | string[]>

/** The supported source runtime used by newly scaffolded native apps. */
export const defaultCraftRuntime: { revision: string, version: string } = {
  revision: 'e1d6e40100ae2c35c96f9d96ed826f08ddf1f48b',
  version: '0.0.367',
}

export function isAndroidPackageName(value: string): boolean {
  const parts = value.split('.')
  return parts.length > 1 && parts.every(part => /^[A-Za-z]\w*$/.test(part))
}
export interface NativeAppConfig {
  environment?: string
  runtime?: { revision: string, version: string }
  build?: string[]
  checks?: { before?: string[][], after?: string[][] }
  macos?: {
    maxBundleSize?: number
    entitlements?: { direct?: Entitlements, appStore?: Entitlements }
    notarize?: boolean
    appStore?: boolean
  }
  android?: { bundle: string, packageName: string, track: string, status: 'draft' | 'completed' | 'inProgress', userFraction?: number }
  registry?: { domain: string, url?: string }
  release?: { draft?: boolean }
}

export function insideProject(root: string, file: string): string {
  const resolved = resolve(root, file)
  if (resolved === resolve(root) || !resolved.startsWith(`${resolve(root)}${sep}`)) throw new Error(`Native output must be inside the project: ${file}`)
  return resolved
}

/** Native settings are data, so the same manifest works in Bun, Node and CI. */
export function readNativeAppConfig(root: string, required = false): NativeAppConfig | undefined {
  const manifest = join(root, 'pantry.json')
  if (!existsSync(manifest)) {
    if (required) throw new Error('Native publishing requires pantry.json with a native configuration')
    return undefined
  }
  const config = JSON.parse(readFileSync(manifest, 'utf8')).native as NativeAppConfig | undefined
  if (!config) {
    if (required) throw new Error('pantry.json must declare native app settings')
    return undefined
  }
  if (config.environment !== undefined && (typeof config.environment !== 'string' || !/^[a-z][a-z0-9-]*$/.test(config.environment))) throw new Error('Invalid native release environment name')
  if (config.runtime && (!/^[a-f0-9]{40}$/.test(config.runtime.revision) || !/^\d+\.\d+\.\d+$/.test(config.runtime.version)))
    throw new Error('Craft requires an immutable 40-character Git revision and an exact version')
  for (const command of [config.build, ...config.checks?.before ?? [], ...config.checks?.after ?? []]) {
    if (command !== undefined && (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string' || !arg)))
      throw new Error('Native commands must be nonempty argument arrays')
  }
  if (config.macos?.maxBundleSize !== undefined && (!Number.isSafeInteger(config.macos.maxBundleSize) || config.macos.maxBundleSize <= 0))
    throw new Error('maxBundleSize must be a positive byte count')
  if (config.registry) {
    if (typeof config.registry.domain !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]|\/(?=[a-z0-9])){0,213}$/i.test(config.registry.domain) || config.registry.domain.includes('..') || config.registry.domain.endsWith('/'))
      throw new Error('Native registry publishing requires an exact package domain')
    if (config.registry.url) {
      const url = new URL(config.registry.url)
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))))
        throw new Error('Native registry URL must use HTTPS, or HTTP on loopback for testing')
    }
    if (!config.macos?.notarize) throw new Error('Native registry apps require notarized macOS distribution')
  }
  if (config.android) {
    insideProject(root, config.android.bundle)
    if (!isAndroidPackageName(config.android.packageName) || !config.android.track || !['draft', 'completed', 'inProgress'].includes(config.android.status))
      throw new Error('Android publishing requires a package name, track and explicit release status')
    const fraction = config.android.userFraction
    if (config.android.status === 'inProgress' ? !(typeof fraction === 'number' && fraction > 0 && fraction < 1) : fraction !== undefined)
      throw new Error('Only an inProgress rollout requires userFraction between zero and one')
  }
  return config
}
