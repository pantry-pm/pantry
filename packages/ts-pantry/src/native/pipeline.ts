import type { NativeArtifact } from './build'
import type { NativeCommand } from './command'
import type { NativeAppConfig } from './config'
import process from 'node:process'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { signNativeAndroidBundle } from './android'
import { auditNativeEnvironment, loadNativeEnvironment } from './environment'
import { assessNativeMacArtifact, notarizeNativeArtifact, packageNativeAppStore, resolveNotaryCredentials, signNativeDiskImage } from './apple'
import { removeAppleSigningKeychain, setupAppleSigning } from './apple-signing'
import { readNativeArtifact } from './build'
import { runNativeCommand, succeeded } from './command'
import { insideProject, readNativeAppConfig } from './config'

export interface NativePipelineResult {
  config: NativeAppConfig
  files: string[]
  version: string
  artifact?: NativeArtifact
  appStorePackage?: string
}

export function nativeBundleSize(directory: string): number {
  const stat = lstatSync(directory)
  if (stat.isSymbolicLink()) throw new Error(`Native app must not contain symbolic links: ${directory}`)
  return stat.isDirectory() ? readdirSync(directory).reduce((size, name) => size + nativeBundleSize(join(directory, name)), 0) : stat.size
}

export async function validateNativeMacApp(artifact: NativeArtifact, maxBytes: number | undefined, command: NativeCommand = runNativeCommand): Promise<void> {
  const app = artifact.appPath ?? artifact.path
  if (!app.endsWith('.app') || !existsSync(app)) throw new Error('Native build must produce a macOS application bundle')
  const plist = join(app, 'Contents/Info.plist')
  const executable = join(app, 'Contents/MacOS', artifact.name)
  for (const file of [plist, executable, join(app, 'Contents/Resources/index.html'), join(app, 'Contents/Resources/craft.json')]) {
    if (!existsSync(file)) throw new Error(`Native app is incomplete: ${file}`)
  }
  const magic = readFileSync(executable).subarray(0, 4).toString('hex')
  if (!['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)) throw new Error('Native app executable must be Mach-O')
  const bytes = nativeBundleSize(app)
  if (maxBytes !== undefined && bytes >= maxBytes) throw new Error(`Native bundle is ${bytes} bytes; it must be below ${maxBytes}`)
  const metadata = JSON.parse(succeeded('Read bundle metadata', await command('plutil', ['-convert', 'json', '-o', '-', plist])).stdout)
  if (metadata.CFBundleIdentifier !== artifact.bundleId || metadata.CFBundleShortVersionString !== artifact.version || String(metadata.CFBundleVersion) !== artifact.buildNumber)
    throw new Error('Built app identity/version does not match the release manifest')
  const benchmark = succeeded('Native launch check', await command(executable, ['--benchmark']))
  if (!`${benchmark.stdout}${benchmark.stderr}`.includes('ready')) throw new Error('Native app did not report ready')
}

/** Shared local/CI pipeline. It prepares artifacts; providers deliver only after checks pass. */
export async function prepareNativeRelease(root: string, mode: 'check' | 'release', dependencies: { command?: NativeCommand, env?: NodeJS.ProcessEnv, onSecret?: (value: string) => void, onEnvironment?: (values: Record<string, string>) => void } = {}): Promise<NativePipelineResult> {
  const config = readNativeAppConfig(root, true)!
  const command = dependencies.command ?? runNativeCommand
  const env = { ...(dependencies.env ?? process.env) }
  if (config.environment) {
    auditNativeEnvironment(root, config.environment)
    if (mode === 'release') {
      const values = loadNativeEnvironment(root, config.environment, dependencies.onSecret)
      Object.assign(env, values, { APP_ENV: config.environment, NODE_ENV: config.environment, DOTENV_ENV: config.environment })
      dependencies.onEnvironment?.(values)
    }
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }
  if (!pkg.version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error('A native release requires a semantic package version')
  env.PANTRY_BUILD_NUMBER = env.PANTRY_BUILD_NUMBER || env.GITHUB_RUN_NUMBER || pkg.version
  if (mode === 'release' && env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME !== `v${pkg.version}`) throw new Error('Release tag must match package.json version')
  if (mode === 'release' && env.CRAFT_BIN) throw new Error('Release builds must use the configured immutable runtime; CRAFT_BIN is a development override')
  // Check every configured provider before building or touching any remote store.
  const notary = mode === 'release' && config.macos?.notarize ? resolveNotaryCredentials(env) : undefined
  if (mode === 'release' && config.android && !env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) throw new Error('Google Play publishing requires GOOGLE_PLAY_SERVICE_ACCOUNT_JSON')
  if (mode === 'release' && config.macos?.appStore && (!env.APPLE_APP_STORE_APPLICATION_CERTIFICATE || !env.APPLE_APP_STORE_INSTALLER_CERTIFICATE || !env.APPLE_APP_STORE_PROVISIONING_PROFILE_BASE64 || !env.APP_STORE_CONNECT_API_KEY_ID || !env.APP_STORE_CONNECT_ISSUER_ID || !env.APP_STORE_CONNECT_PRIVATE_KEY))
    throw new Error('App Store publishing requires distribution certificates, provisioning profile and App Store Connect credentials')
  if (mode === 'release' && config.macos && !(env.APPLE_SIGNING_IDENTITY || env.APPLE_APPLICATION_CERTIFICATE)) throw new Error('Native macOS releases require an application signing identity or certificate')
  const run = async (args: string[]) => succeeded(args[0]!, await command(args[0]!, args.slice(1), { cwd: root, env, inherit: true }))
  const signing: string[] = []
  try {
    if (mode === 'release' && config.macos && env.APPLE_APPLICATION_CERTIFICATE) {
      const result = await setupAppleSigning({ applicationCertificate: env.APPLE_APPLICATION_CERTIFICATE, certificatePassword: env.APPLE_CERTIFICATE_PASSWORD || '', provisioningProfile: env.APPLE_PROVISIONING_PROFILE_BASE64 })
      signing.push(result.keychainPath)
      env.APPLE_SIGNING_IDENTITY = result.applicationFingerprint
      if (result.provisioningProfilePath) env.APPLE_PROVISIONING_PROFILE_PATH = result.provisioningProfilePath
    }
    await run(['bun', 'install', '--frozen-lockfile'])
    for (const check of config.checks?.before ?? []) await run(check)
    // A failed build cannot reuse an earlier run's successful manifest.
    rmSync(join(root, '.pantry/native/artifact.json'), { force: true })
    await run(config.build ?? ['bun', 'run', 'package'])
    if (mode === 'release' && config.android) await signNativeAndroidBundle(insideProject(root, config.android.bundle), env, command)
    const artifact = config.macos ? readNativeArtifact(root) : undefined
    if (artifact) {
      if (artifact.version !== pkg.version) throw new Error('Native artifact belongs to a different package version')
      await validateNativeMacApp(artifact, config.macos?.maxBundleSize, command)
    }
    for (const check of config.checks?.after ?? []) await run(check)
    const files = artifact ? [artifact.path] : config.android ? [insideProject(root, config.android.bundle)] : []
    if (!files.length || files.some(file => !existsSync(file))) throw new Error('Native pipeline produced no release files')
    if (artifact && mode === 'release') {
      succeeded('Release signature', await command('codesign', ['--verify', '--deep', '--strict', artifact.appPath ?? artifact.path]))
      const identity = succeeded('Release identity', await command('codesign', ['-dv', '--verbose=4', artifact.appPath ?? artifact.path]))
      if (!`${identity.stdout}${identity.stderr}`.includes('Authority=Developer ID Application:')) throw new Error('Direct macOS releases require a Developer ID signature')
      if (artifact.path.toLowerCase().endsWith('.dmg')) await signNativeDiskImage(artifact.path, env.APPLE_SIGNING_IDENTITY!, command)
    }
    if (notary) {
      const receipt = await notarizeNativeArtifact(files[0]!, notary, command)
      if (artifact?.appPath) await assessNativeMacArtifact(artifact.appPath, command)
      if (!files[0]!.toLowerCase().endsWith('.zip')) await assessNativeMacArtifact(files[0]!, command)
      const receiptPath = join(dirname(files[0]!), 'notarization-receipt.json')
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
      files.push(receiptPath)
    }
    let appStorePackage: string | undefined
    if (mode === 'release' && config.macos?.appStore) {
      const result = await setupAppleSigning({ applicationCertificate: env.APPLE_APP_STORE_APPLICATION_CERTIFICATE!, installerCertificate: env.APPLE_APP_STORE_INSTALLER_CERTIFICATE, certificatePassword: env.APPLE_CERTIFICATE_PASSWORD || '', provisioningProfile: env.APPLE_APP_STORE_PROVISIONING_PROFILE_BASE64 })
      signing.push(result.keychainPath)
      env.PANTRY_DISTRIBUTION = 'app-store'
      env.APPLE_SIGNING_IDENTITY = result.applicationFingerprint
      env.APPLE_PROVISIONING_PROFILE_PATH = result.provisioningProfilePath
      rmSync(insideProject(root, '.pantry/native/app-store'), { recursive: true, force: true })
      await run(['bun', 'run', 'build'])
      const store = readNativeArtifact(root)
      await validateNativeMacApp(store, config.macos.maxBundleSize, command)
      appStorePackage = join(dirname(files[0]!), `${basename(store.appPath ?? store.path, '.app')}-${pkg.version}.pkg`)
      await packageNativeAppStore(store.appPath ?? store.path, appStorePackage, result.installerFingerprint!, command)
      files.push(appStorePackage)
    }
    return { config, version: pkg.version, files, ...(artifact ? { artifact } : {}), ...(appStorePackage ? { appStorePackage } : {}) }
  }
  finally { for (const keychain of signing.reverse()) await removeAppleSigningKeychain(keychain) }
}
