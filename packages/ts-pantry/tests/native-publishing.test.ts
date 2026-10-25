import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encryptValue, generateKeypair } from '@stacksjs/env/crypto'
import type { NativeCommand } from '../src/native'
import { auditNativeEnvironment, deliverReleaseToGooglePlay, exportAppleKeychainIdentity, loadNativeEnvironment, lockedCraftCompilerVersion, nativeEntitlementsPlist, nativeRuntimeCacheKey, notarizeNativeArtifact, packageNativeAppStore, prepareNativeAppBuild, prepareNativeRelease, readNativeAppConfig, resolveNotaryCredentials, setupAppleSigning, signNativeAndroidBundle } from '../src/native'

const directories: string[] = []
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'pantry-native-'))
  directories.push(root)
  return root
}
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }) })
const ok = { exitCode: 0, stdout: '', stderr: '' }

describe('Buddy encrypted release environments', () => {
  test('reads the production file with Buddy keys, masks values and preserves multiline keys', () => {
    const root = temporary()
    const keys = generateKeypair()
    const value = '-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----\n'
    writeFileSync(join(root, '.env.production'), `DOTENV_PUBLIC_KEY_PRODUCTION="${keys.publicKey}"\nAPP_STORE_CONNECT_PRIVATE_KEY="${encryptValue(value, keys.publicKey)}"\n`)
    writeFileSync(join(root, '.env.keys'), `DOTENV_PRIVATE_KEY_PRODUCTION="${keys.privateKey}"\n`, { mode: 0o600 })
    const masked: string[] = []
    expect(loadNativeEnvironment(root, 'production', secret => masked.push(secret))).toEqual({ APP_STORE_CONNECT_PRIVATE_KEY: value })
    expect(masked).toEqual([value])
    rmSync(join(root, '.env.keys'))
    // Fork CI can validate ciphertext without receiving a production key.
    expect(() => auditNativeEnvironment(root, 'production')).not.toThrow()
    expect(() => loadNativeEnvironment(root, 'production')).toThrow('Cannot read')
    const previous = process.env.DOTENV_PRIVATE_KEY_PRODUCTION
    try {
      process.env.DOTENV_PRIVATE_KEY_PRODUCTION = keys.privateKey
      expect(loadNativeEnvironment(root, 'production')).toEqual({ APP_STORE_CONNECT_PRIVATE_KEY: value })
    }
    finally {
      if (previous === undefined) delete process.env.DOTENV_PRIVATE_KEY_PRODUCTION
      else process.env.DOTENV_PRIVATE_KEY_PRODUCTION = previous
    }
  })
  test('rejects plaintext, private-key assignments and wrong keys without printing values', () => {
    const root = temporary()
    const keys = generateKeypair()
    const file = join(root, '.env.production')
    writeFileSync(file, `DOTENV_PUBLIC_KEY_PRODUCTION="${keys.publicKey}"\nTOKEN="secret-must-not-be-logged"\n`)
    expect(() => auditNativeEnvironment(root, 'production')).toThrow('Buddy-encrypted: TOKEN')
    writeFileSync(file, `DOTENV_PUBLIC_KEY_PRODUCTION="${keys.publicKey}"\nDOTENV_PRIVATE_KEY_PRODUCTION="${encryptValue('private', keys.publicKey)}"\n`)
    expect(() => auditNativeEnvironment(root, 'production')).toThrow('must never be committed')
    writeFileSync(file, `DOTENV_PUBLIC_KEY_PRODUCTION="${keys.publicKey}"\nTOKEN="${encryptValue('secret-must-not-be-logged', keys.publicKey)}"\n`)
    writeFileSync(join(root, '.env.keys'), `DOTENV_PRIVATE_KEY_PRODUCTION="${generateKeypair().privateKey}"\n`)
    expect(() => loadNativeEnvironment(root, 'production')).toThrow('Cannot read')
  })
})

describe('native configuration and builds', () => {
  test('rejects mutable runtime pins, invalid commands and rollout configuration', () => {
    const root = temporary()
    const write = (native: unknown) => writeFileSync(join(root, 'pantry.json'), JSON.stringify({ native }))
    write({ runtime: { revision: 'main', version: '0.0.295' } })
    expect(() => readNativeAppConfig(root)).toThrow('immutable')
    write({ checks: { after: ['bun run test'] } })
    expect(() => readNativeAppConfig(root)).toThrow('argument arrays')
    write({ android: { bundle: '../app.aab', packageName: 'com.example.app', track: 'internal', status: 'completed' } })
    expect(() => readNativeAppConfig(root)).toThrow('inside the project')
    write({ android: { bundle: 'dist/app.aab', packageName: 'com.example.app', track: 'production', status: 'inProgress' } })
    expect(() => readNativeAppConfig(root)).toThrow('userFraction')
  })
  test('cache identity includes architecture and deployment target', () => {
    const config = { runtime: { revision: 'd'.repeat(40), version: '0.0.295' } }
    expect(nativeRuntimeCacheKey(config, '13.0', 'arm64')).not.toBe(nativeRuntimeCacheKey(config, '14.0', 'arm64'))
    expect(nativeRuntimeCacheKey(config, '13.0', 'arm64')).not.toBe(nativeRuntimeCacheKey(config, '13.0', 'x64'))
    expect(lockedCraftCompilerVersion({ workspaces: { '': { system: { 'ziglang.org': '0.18.0-dev.146+35accc06e' } } } })).toBe('0.18.0-dev.146+35accc06e')
    expect(() => lockedCraftCompilerVersion({ workspaces: { '': { system: { 'ziglang.org': '^0.18' } } } })).toThrow('exact Zig')
  })
  test('build inputs stay temporary and preserve the native runtime override', async () => {
    const root = temporary()
    const binary = join(root, 'craft')
    const profile = join(root, 'profile')
    writeFileSync(binary, 'development runtime')
    writeFileSync(profile, 'profile')
    writeFileSync(join(root, 'pantry.json'), JSON.stringify({ native: { macos: { entitlements: { direct: { 'com.apple.developer.usernotifications.communication': true } } } } }))
    const result = await prepareNativeAppBuild(root, { env: { CRAFT_BIN: binary, APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example', APPLE_PROVISIONING_PROFILE: profile } })
    const entitlements = result.overrides.macosSigning!.entitlements!
    expect(readFileSync(entitlements, 'utf8')).toContain('<true/>')
    expect(result.overrides.craftPath).toBe(binary)
    result.cleanup()
    expect(existsSync(entitlements)).toBe(false)
    expect(nativeEntitlementsPlist({ 'a&b': ['<value>'], enabled: false })).toContain('<key>a&amp;b</key><array><string>&lt;value&gt;</string></array>')
  })
  test('missing release credentials and failed checks stop before artifact creation', async () => {
    const root = temporary()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    writeFileSync(join(root, 'pantry.json'), JSON.stringify({ native: { macos: { notarize: true }, checks: { before: [['bun', 'run', 'lint']] } } }))
    const calls: string[][] = []
    const command: NativeCommand = async (name, args) => {
      calls.push([name, ...args])
      return args.includes('lint') ? { exitCode: 1, stdout: '', stderr: 'lint failed' } : ok
    }
    await expect(prepareNativeRelease(root, 'release', { env: {}, command })).rejects.toThrow('Notarization requires')
    expect(calls).toHaveLength(0)
    await expect(prepareNativeRelease(root, 'check', { env: {}, command })).rejects.toThrow('lint failed')
    expect(calls).toEqual([['bun', 'install', '--frozen-lockfile'], ['bun', 'run', 'lint']])
  })
})

describe('Apple native publishing', () => {
  test('exports only an exact identity through Security.framework with no password on argv', async () => {
    const root = temporary()
    const output = join(root, 'identity.p12')
    await exportAppleKeychainIdentity({ fingerprint: 'AB'.repeat(20), password: 'generated archive password', output }, {
      platform: 'darwin',
      command: async (name, args, options) => {
        expect(name).toBe('xcrun')
        expect(args).toEqual(['swift', '-'])
        expect(options!.env!.PANTRY_IDENTITY_FINGERPRINT).toBe('AB'.repeat(20))
        expect(options!.input).toContain('SecItemExport(matches[0]')
        writeFileSync(output, 'encrypted identity')
        return ok
      },
    })
    await expect(exportAppleKeychainIdentity({ fingerprint: 'AB'.repeat(20), password: 'generated archive password', output })).rejects.toThrow('overwrite')
  })
  test('requires Accepted, staples before hashing, and removes API key files', async () => {
    const root = temporary()
    const dmg = join(root, 'Example.dmg')
    writeFileSync(dmg, 'unstapled')
    let key = ''
    const calls: string[][] = []
    const command: NativeCommand = async (_name, args) => {
      calls.push(args)
      if (args[0] === 'notarytool') {
        key = args[args.indexOf('--key') + 1]!
        expect(readFileSync(key, 'utf8')).toBe('private key')
        expect(args).not.toContain('private key')
        return { ...ok, stdout: JSON.stringify({ id: 'submission-id', status: 'Accepted' }) }
      }
      if (args[1] === 'staple') writeFileSync(dmg, 'stapled')
      return ok
    }
    const receipt = await notarizeNativeArtifact(dmg, { apiKeyId: 'ABC123', issuerId: 'issuer', privateKey: 'private key' }, command)
    expect(calls.map(args => args.slice(0, 2))).toEqual([['notarytool', 'submit'], ['stapler', 'staple'], ['stapler', 'validate']])
    expect(receipt.sha256).toBe(createHash('sha256').update('stapled').digest('hex'))
    expect(existsSync(key)).toBe(false)
    await expect(notarizeNativeArtifact(dmg, { keychainProfile: 'existing' }, async () => ({ ...ok, stdout: JSON.stringify({ id: 'rejected-id', status: 'Invalid' }) }))).rejects.toThrow('did not accept')
    expect(() => resolveNotaryCredentials({ APP_STORE_CONNECT_API_KEY_ID: 'partial' })).toThrow('complete')
  })
  test('a false sandbox entitlement cannot produce an App Store package', async () => {
    const root = temporary()
    const app = join(root, 'Example.app')
    mkdirSync(join(app, 'Contents'), { recursive: true })
    writeFileSync(join(app, 'Contents/embedded.provisionprofile'), 'profile')
    const calls: string[] = []
    await expect(packageNativeAppStore(app, join(root, 'Example.pkg'), 'Installer', async (name) => {
      calls.push(name)
      return { ...ok, stdout: name === 'plutil' ? JSON.stringify({ 'com.apple.security.app-sandbox': false }) : '<plist/>' }
    })).rejects.toThrow('sandbox must be enabled')
    expect(calls).not.toContain('productbuild')
  })
  test('failed certificate import deletes its keychain and credential files', async () => {
    const root = temporary()
    let keychain = ''
    let removed = false
    await expect(setupAppleSigning({ applicationCertificate: Buffer.from('p12').toString('base64'), certificatePassword: 'password' }, {
      platform: 'darwin', tempDirectory: root,
      runCommand: async (_name, args) => {
        if (args[0] === 'create-keychain') keychain = args.at(-1)!
        if (args[0] === 'delete-keychain') removed = true
        return args[0] === 'import' ? { exitCode: 1, stdout: '', stderr: 'import rejected' } : ok
      },
    })).rejects.toThrow('import rejected')
    expect(removed).toBe(true)
    expect(existsSync(keychain)).toBe(false)
  })
})

describe('Google Play delivery', () => {
  test('Android passwords stay in the child environment and the temporary key is removed', async () => {
    const root = temporary()
    const bundle = join(root, 'app.aab')
    writeFileSync(bundle, 'unsigned')
    let key = ''
    const env = { ANDROID_KEYSTORE_BASE64: Buffer.from('keystore').toString('base64'), ANDROID_KEYSTORE_PASSWORD: 'store secret', ANDROID_KEY_PASSWORD: 'key secret', ANDROID_KEY_ALIAS: 'release' }
    await signNativeAndroidBundle(bundle, env, async (_name, args, options) => {
      expect(args).not.toContain('store secret')
      expect(args).not.toContain('key secret')
      if (args.includes('-signedjar')) {
        key = args[args.indexOf('-keystore') + 1]!
        expect(readFileSync(key, 'utf8')).toBe('keystore')
        expect(options!.env!.PANTRY_ANDROID_STORE_PASSWORD).toBe('store secret')
        writeFileSync(args[args.indexOf('-signedjar') + 1]!, 'signed')
      }
      return { ...ok, stdout: 'jar verified.' }
    })
    expect(readFileSync(bundle, 'utf8')).toBe('signed')
    expect(existsSync(key)).toBe(false)
    await expect(signNativeAndroidBundle(bundle, {}, async () => ({ ...ok, stdout: 'jar is unsigned.' }))).rejects.toThrow('not signed')
  })
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const serviceAccount = JSON.stringify({ type: 'service_account', client_email: 'release@example.iam.gserviceaccount.com', private_key: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() })
  function fixture() {
    const root = temporary()
    const bundle = join(root, 'app.aab')
    writeFileSync(bundle, 'signed Android app bundle')
    return { bundle, packageName: 'com.example.app', track: 'internal', status: 'completed' as const, serviceAccount }
  }
  test('authenticates with the publisher scope, verifies bytes, validates and commits', async () => {
    const options = fixture()
    const requests: { url: string, method?: string, body?: unknown }[] = []
    const request = (async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url)
      requests.push({ url: address, method: init?.method, body: init?.body })
      if (address.includes('oauth2')) {
        const assertion = new URLSearchParams(init?.body as URLSearchParams).get('assertion')!
        const claims = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString())
        expect(claims.scope).toBe('https://www.googleapis.com/auth/androidpublisher')
        return Response.json({ access_token: 'scoped-token' })
      }
      if (address.includes('/upload/')) return Response.json({ versionCode: 42, sha256: createHash('sha256').update(readFileSync(options.bundle)).digest('hex') })
      if (address.includes(':commit')) return Response.json({ id: 'edit-1' })
      return Response.json({ id: 'edit-1' })
    }) as typeof fetch
    const receipt = await deliverReleaseToGooglePlay(options, { fetch: request })
    expect(receipt.committed).toBe(true)
    expect(receipt.versionCode).toBe(42)
    expect(requests.map(item => item.method)).toEqual(['POST', 'POST', 'POST', 'PUT', 'POST', 'POST'])
    expect(requests.at(-1)!.url).toContain('changesInReviewBehavior=ERROR_IF_IN_REVIEW')
    expect(JSON.parse(requests[3]!.body as string).releases[0]).toEqual({ status: 'completed', versionCodes: ['42'] })
  })
  test('a byte mismatch never updates the track or commits, and deletes the edit', async () => {
    const options = fixture()
    const methods: string[] = []
    const request = (async (url: string | URL | Request, init?: RequestInit) => {
      methods.push(init!.method!)
      if (String(url).includes('oauth2')) return Response.json({ access_token: 'token' })
      if (String(url).includes('/upload/')) return Response.json({ versionCode: 42, sha256: 'wrong' })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({ id: 'edit-2' })
    }) as typeof fetch
    await expect(deliverReleaseToGooglePlay(options, { fetch: request })).rejects.toThrow('does not match')
    expect(methods).toEqual(['POST', 'POST', 'POST', 'DELETE'])
  })
})
