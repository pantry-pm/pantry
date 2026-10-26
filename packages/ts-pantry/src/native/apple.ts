import type { NativeCommand } from './command'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runNativeCommand, succeeded } from './command'

export type NotaryCredentials = { keychainProfile: string } | { apiKeyId: string, issuerId: string, privateKey: string } | { appleId: string, password: string, teamId: string }

export function resolveNotaryCredentials(env: NodeJS.ProcessEnv = process.env): NotaryCredentials {
  if (env.APPLE_NOTARY_KEYCHAIN_PROFILE) return { keychainProfile: env.APPLE_NOTARY_KEYCHAIN_PROFILE }
  const apiKeyId = env.APP_STORE_CONNECT_API_KEY_ID
  const issuerId = env.APP_STORE_CONNECT_ISSUER_ID || env.APP_STORE_CONNECT_API_ISSUER_ID
  const privateKey = env.APP_STORE_CONNECT_PRIVATE_KEY || (env.APP_STORE_CONNECT_API_KEY_PATH ? readFileSync(env.APP_STORE_CONNECT_API_KEY_PATH, 'utf8') : undefined)
  if (apiKeyId || issuerId || privateKey) {
    if (!apiKeyId || !issuerId || !privateKey) throw new Error('Notarization requires complete App Store Connect API credentials')
    if (!/^[A-Z0-9]+$/.test(apiKeyId)) throw new Error('Invalid App Store Connect API key ID')
    return { apiKeyId, issuerId, privateKey }
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
    return { appleId: env.APPLE_ID, password: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID }
  throw new Error('Notarization requires an existing keychain profile, App Store Connect API key, or Apple ID credentials')
}

/** Require Apple's Accepted status, then staple and validate the ticket. */
export interface NotarizationReceipt { schemaVersion: number, file: string, submissionId: string, status: string, sha256: string, completedAt: string }

/** Sign the outer distribution container as well as the app it contains. */
export async function signNativeDiskImage(file: string, identity: string, command: NativeCommand = runNativeCommand): Promise<void> {
  if (!existsSync(file) || !file.toLowerCase().endsWith('.dmg') || !identity) throw new Error('Disk image signing requires an existing DMG and a Developer ID Application identity')
  succeeded('Sign disk image', await command('codesign', ['--force', '--sign', identity, '--timestamp', file]))
  succeeded('Disk image signature', await command('codesign', ['--verify', '--strict', file]))
  const signature = succeeded('Disk image identity', await command('codesign', ['-dv', '--verbose=4', file]))
  const metadata = `${signature.stdout}\n${signature.stderr}`
  if (!metadata.includes('Authority=Developer ID Application:') || !/^Timestamp=/m.test(metadata)) throw new Error('Disk image requires a timestamped Developer ID Application signature')
}

/** Notary acceptance alone does not establish the download's Gatekeeper policy. */
export async function assessNativeMacArtifact(file: string, command: NativeCommand = runNativeCommand): Promise<void> {
  const args = file.toLowerCase().endsWith('.dmg') ? ['--type', 'open', '--context', 'context:primary-signature']
    : file.toLowerCase().endsWith('.app') ? ['--type', 'exec']
      : file.toLowerCase().endsWith('.pkg') ? ['--type', 'install'] : undefined
  if (!existsSync(file) || !args) throw new Error('Gatekeeper assessment requires an existing app, DMG or PKG')
  const result = succeeded('Gatekeeper assessment', await command('spctl', ['--assess', ...args, '--verbose=2', file]))
  if (!`${result.stdout}\n${result.stderr}`.includes('source=Notarized Developer ID')) throw new Error('Gatekeeper did not recognize the notarized Developer ID distribution')
}

async function runStapler(action: 'staple' | 'validate', file: string, command: NativeCommand): Promise<void> {
  const label = action === 'staple' ? 'Staple notarization' : 'Validate notarization'
  for (let attempt = 0; ; attempt++) {
    const result = await command('xcrun', ['stapler', action, file])
    // Apple's ticket service can sever a connection after issuing the ticket.
    // Retry only identified transport failures, never an invalid/revoked ticket
    // or a bare stapler exit code. A release still requires successful validation.
    const transportFailure = /NSURLErrorDomain\s+Code=-(?:1001|1003|1004|1005|1009)\b/.test(`${result.stdout}\n${result.stderr}`)
    if (result.exitCode === 0 || !transportFailure || attempt === 4) {
      succeeded(label, result)
      return
    }
    await delay(1000 * 2 ** attempt)
  }
}

export async function notarizeNativeArtifact(file: string, credentials: NotaryCredentials, command: NativeCommand = runNativeCommand): Promise<NotarizationReceipt> {
  if (!existsSync(file) || !/\.(dmg|pkg|zip)$/i.test(file)) throw new Error('Notarization requires an existing DMG, PKG or ZIP')
  const directory = mkdtempSync(join(tmpdir(), 'pantry-notary-'))
  try {
    let auth: string[]
    if ('keychainProfile' in credentials) auth = ['--keychain-profile', credentials.keychainProfile]
    else if ('apiKeyId' in credentials) {
      const key = join(directory, 'AuthKey.p8')
      writeFileSync(key, credentials.privateKey, { mode: 0o600 })
      auth = ['--key', key, '--key-id', credentials.apiKeyId, '--issuer', credentials.issuerId]
    }
    else auth = ['--apple-id', credentials.appleId, '--password', credentials.password, '--team-id', credentials.teamId]
    const result = succeeded('Apple notarization', await command('xcrun', ['notarytool', 'submit', file, ...auth, '--wait', '--timeout', '30m', '--output-format', 'json']))
    const submission = JSON.parse(result.stdout) as { id?: string, status?: string }
    if (!submission.id || submission.status !== 'Accepted') throw new Error(`Apple did not accept notarization: ${submission.status ?? 'unknown status'} (${submission.id ?? 'no submission ID'})`)
    // ZIPs cannot carry a stapled ticket. Their signed app must be stapled by
    // the caller before archiving; native release pipelines use DMGs or PKGs.
    if (!file.toLowerCase().endsWith('.zip')) {
      await runStapler('staple', file, command)
      await runStapler('validate', file, command)
    }
    return { schemaVersion: 1, file: basename(file), submissionId: submission.id, status: submission.status, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), completedAt: new Date().toISOString() }
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

export async function packageNativeAppStore(app: string, output: string, installerIdentity: string, command: NativeCommand = runNativeCommand): Promise<string> {
  if (!app.endsWith('.app') || !existsSync(app) || !output.endsWith('.pkg') || !installerIdentity) throw new Error('App Store packaging requires an app, .pkg output and installer identity')
  if (existsSync(output)) throw new Error(`Refusing to overwrite an existing package: ${output}`)
  if (!existsSync(join(app, 'Contents/embedded.provisionprofile'))) throw new Error('App Store app is missing its provisioning profile')
  succeeded('App signature', await command('codesign', ['--verify', '--deep', '--strict', app]))
  const signed = succeeded('Read signed entitlements', await command('codesign', ['-d', '--entitlements', ':-', app]))
  const directory = mkdtempSync(join(tmpdir(), 'pantry-app-store-package-'))
  try {
    const entitlements = join(directory, 'entitlements.plist')
    writeFileSync(entitlements, signed.stdout || signed.stderr)
    const sandbox = JSON.parse(succeeded('App sandbox entitlement', await command('plutil', ['-convert', 'json', '-o', '-', entitlements])).stdout)
    if (sandbox['com.apple.security.app-sandbox'] !== true) throw new Error('App Store app sandbox must be enabled')
    succeeded('Create signed App Store package', await command('productbuild', ['--component', app, '/Applications', '--sign', installerIdentity, output], { cwd: dirname(output) }))
    succeeded('Installer signature', await command('pkgutil', ['--check-signature', output]))
    if (!existsSync(output)) throw new Error('productbuild did not produce the requested package')
    return output
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
}
