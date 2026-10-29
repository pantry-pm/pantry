import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AppStoreConnectClient, ensureAppStoreVersions, waitForAppStoreBuilds } from '../app-store-connect'
import { prepareAppStoreSubmission, submitAppStore } from '../app-store-submission'
import type { AppStoreMetadata, AppStoreSubmissionResult } from '../app-store-submission'
import { loadNativeEnvironment } from './environment'
import { readNativeAppConfig } from './config'
import { prepareNativeRelease } from './pipeline'
import type { NativePipelineResult } from './pipeline'
import { deliverReleaseToAppStore } from './release-app-store'
import type { AppStoreReleaseReceipt } from './release-app-store'

export type NativeAppStoreMetadata = Omit<AppStoreMetadata, 'reviewContact'> & {
  reviewContact?: AppStoreMetadata['reviewContact']
  reviewNotes?: string
}

export interface NativeAppleOptions {
  packageOnly?: boolean
  validateOnly?: boolean
  submitForReview?: boolean
  buildNumber?: string
}
export interface NativeApplePublication {
  prepared: NativePipelineResult
  delivery?: AppStoreReleaseReceipt
  submission?: AppStoreSubmissionResult
}

async function metadataFor(root: string, env: NodeJS.ProcessEnv): Promise<AppStoreMetadata> {
  const source = join(root, 'app-store.config.ts')
  const json = join(root, 'app-store.config.json')
  const metadata = (existsSync(json) ? JSON.parse(readFileSync(json, 'utf8')) : existsSync(source) ? (await import(pathToFileURL(source).href)).default : null) as NativeAppStoreMetadata | null
  if (!metadata) throw new Error('Create app-store.config.ts or app-store.config.json before publishing')
  const contact = metadata.reviewContact ?? (env.APP_STORE_REVIEW_CONTACT ? JSON.parse(env.APP_STORE_REVIEW_CONTACT) : undefined)
  if (!contact?.firstName || !contact.lastName || !contact.phone || !contact.email) throw new Error('Provide reviewContact in app-store.config or encrypted APP_STORE_REVIEW_CONTACT')
  if (metadata.subtitle && metadata.subtitle.length > 30) throw new Error('App Store subtitle must be at most 30 characters')
  return { ...metadata, reviewContact: { ...contact, ...(metadata.reviewNotes ? { notes: metadata.reviewNotes } : {}) } }
}

async function withStoreClient<T>(env: NodeJS.ProcessEnv, run: (client: AppStoreConnectClient, keyPath: string) => Promise<T>): Promise<T> {
  if (!env.APP_STORE_CONNECT_API_KEY_ID || !env.APP_STORE_CONNECT_ISSUER_ID || !env.APP_STORE_CONNECT_PRIVATE_KEY) throw new Error('Provide the App Store Connect credentials in the native release environment')
  const directory = mkdtempSync(join(tmpdir(), 'pantry-store-client-'))
  const keyPath = join(directory, 'AuthKey.p8')
  writeFileSync(keyPath, env.APP_STORE_CONNECT_PRIVATE_KEY, { mode: 0o600 })
  try {
    return await run(new AppStoreConnectClient({ keyId: env.APP_STORE_CONNECT_API_KEY_ID, issuerId: env.APP_STORE_CONNECT_ISSUER_ID, keyPath }), keyPath)
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

/** Buddy and other native hosts use the same qualification, signing and delivery pipeline. */
export async function publishNativeApple(root: string, options: NativeAppleOptions = {}): Promise<NativeApplePublication> {
  if (options.buildNumber !== undefined && !/^[1-9]\d*$/.test(options.buildNumber)) throw new Error('App Store build number must be a positive integer')
  const config = readNativeAppConfig(root, true)!
  if (!config.macos?.appStore) throw new Error('Enable native.macos.appStore in pantry.json before publishing to Apple')
  if (options.packageOnly && (options.validateOnly || options.submitForReview)) throw new Error('Package-only cannot validate or submit a release')
  if (options.validateOnly && options.submitForReview) throw new Error('Validation-only cannot submit a release')
  const env = { ...process.env, ...loadNativeEnvironment(root, config.environment ?? 'production') }
  if (options.buildNumber) env.PANTRY_BUILD_NUMBER = options.buildNumber
  const metadata = options.packageOnly || options.validateOnly ? undefined : await metadataFor(root, env)
  const prepared = await prepareNativeRelease(root, 'release', { env })
  if (!prepared.appStorePackage || !prepared.artifact) throw new Error('The native pipeline did not produce a qualified App Store package')
  if (options.packageOnly) return { prepared }
  const delivery = await deliverReleaseToAppStore({
    package: prepared.appStorePackage, bundleId: prepared.artifact.bundleId,
    version: prepared.version, buildNumber: prepared.artifact.buildNumber,
    apiKeyId: env.APP_STORE_CONNECT_API_KEY_ID!, issuerId: env.APP_STORE_CONNECT_ISSUER_ID!, privateKey: env.APP_STORE_CONNECT_PRIVATE_KEY!,
    validateOnly: options.validateOnly ?? false, retryExisting: false, dryRun: false,
  })
  if (options.validateOnly) return { prepared, delivery }
  const submission = await withStoreClient(env, async (client) => {
    const app = await client.findApp(prepared.artifact!.bundleId)
    if (!app) throw new Error('Create the App Store Connect app record before preparing its listing')
    const versions = await ensureAppStoreVersions(client, app.id, [{ platform: 'MAC_OS', version: prepared.version }])
    if (versions.some(version => version.status !== 'ready')) throw new Error('The App Store version is not editable')
    const builds = await waitForAppStoreBuilds(client, app.id, versions, prepared.artifact!.buildNumber)
    return await prepareAppStoreSubmission(client, metadata!, app.id, versions.map(version => ({ platform: 'macos', id: version.id, buildId: builds.find(build => build.versionId === version.id)?.buildId })), { cwd: root, submit: options.submitForReview ?? metadata!.submitForReview ?? false })
  })
  return { prepared, delivery, submission }
}

/** Submit the exact build CI already uploaded, without rebuilding or re-uploading it. */
export async function submitNativeApple(root: string, options: { buildNumber: string, bundleId?: string, submitForReview?: boolean }): Promise<AppStoreSubmissionResult> {
  if (options.buildNumber !== undefined && !/^[1-9]\d*$/.test(options.buildNumber)) throw new Error('App Store build number must be a positive integer')
  const config = readNativeAppConfig(root, true)!
  const env = { ...process.env, ...loadNativeEnvironment(root, config.environment ?? 'production') }
  const metadata = await metadataFor(root, env)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  const bundleId = options.bundleId ?? (JSON.parse(readFileSync(join(root, '.pantry/native/artifact.json'), 'utf8')) as { bundleId: string }).bundleId
  return await withStoreClient(env, async (client, keyPath) => {
    const app = await client.findApp(bundleId)
    if (!app) throw new Error('The App Store Connect app record is missing')
    const versions = await ensureAppStoreVersions(client, app.id, [{ platform: 'MAC_OS', version: pkg.version }])
    if (versions.some(version => version.status !== 'ready')) throw new Error('The App Store version is not editable')
    await waitForAppStoreBuilds(client, app.id, versions, options.buildNumber)
    return await submitAppStore(metadata, { bundleId, version: pkg.version, keyId: env.APP_STORE_CONNECT_API_KEY_ID, issuerId: env.APP_STORE_CONNECT_ISSUER_ID, keyPath, cwd: root, submit: options.submitForReview ?? false })
  })
}
