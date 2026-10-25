import type { NativeCommand } from './command'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
      succeeded('Staple notarization', await command('xcrun', ['stapler', 'staple', file]))
      succeeded('Validate notarization', await command('xcrun', ['stapler', 'validate', file]))
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
