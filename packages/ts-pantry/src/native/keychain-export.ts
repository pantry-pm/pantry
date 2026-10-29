import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import type { NativeCommand } from './command'
import { runNativeCommand, succeeded } from './command'

// Security.framework exports the selected SecIdentity itself. `security export
// -t identities` cannot filter a keychain, and would export unrelated keys too.
const exporter = String.raw`
import Foundation
import Security
import CryptoKit

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
let environment = ProcessInfo.processInfo.environment
guard let fingerprint = environment["PANTRY_IDENTITY_FINGERPRINT"],
      let password = environment["PANTRY_P12_PASSWORD"],
      let output = environment["PANTRY_P12_OUTPUT"] else { fail("Missing identity export inputs") }
var references: CFTypeRef?
let query: [String: Any] = [kSecClass as String: kSecClassIdentity,
  kSecMatchLimit as String: kSecMatchLimitAll, kSecReturnRef as String: true]
let lookup = SecItemCopyMatching(query as CFDictionary, &references)
guard lookup == errSecSuccess, let identities = references as? [SecIdentity] else {
  fail("Could not read signing identities (Security status \(lookup))")
}
var matches: [SecIdentity] = []
for identity in identities {
  var certificate: SecCertificate?
  guard SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess,
        let certificate = certificate else { continue }
  let bytes = SecCertificateCopyData(certificate) as Data
  let digest = fingerprint.count == 64
    ? SHA256.hash(data: bytes).map { String(format: "%02X", $0) }.joined()
    : Insecure.SHA1.hash(data: bytes).map { String(format: "%02X", $0) }.joined()
  if digest == fingerprint { matches.append(identity) }
}
guard matches.count == 1 else { fail("Expected exactly one identity matching the requested fingerprint") }
var parameters = SecItemImportExportKeyParameters()
parameters.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
let passphrase = password as CFString
parameters.passphrase = Unmanaged.passUnretained(passphrase)
var exported: CFData?
let status = withExtendedLifetime(passphrase) {
  SecItemExport(matches[0], .formatPKCS12, [], &parameters, &exported)
}
guard status == errSecSuccess, let exported = exported else {
  fail("Could not export the selected signing identity (Security status \(status))")
}
guard FileManager.default.createFile(atPath: output, contents: exported as Data,
  attributes: [.posixPermissions: 0o600]) else { fail("Could not write the encrypted identity archive") }
`

/** Export exactly one identity; never enumerate private keys into an archive. */
export async function exportAppleKeychainIdentity(options: { fingerprint: string, password: string, output: string }, dependencies: { command?: NativeCommand, platform?: NodeJS.Platform } = {}): Promise<string> {
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('Keychain identity export requires macOS')
  const fingerprint = options.fingerprint.replaceAll(':', '').toUpperCase()
  if (!/^[A-F0-9]{40}$|^[A-F0-9]{64}$/.test(fingerprint)) throw new Error('An exact certificate SHA-1 or SHA-256 fingerprint is required')
  if (options.password.length < 16) throw new Error('Use a generated archive password of at least 16 characters')
  const output = resolve(options.output)
  if (existsSync(output)) throw new Error('Refusing to overwrite an existing identity archive')
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
  const command = dependencies.command ?? runNativeCommand
  succeeded('Scoped Apple identity export', await command('xcrun', ['swift', '-'], { input: exporter, env: { ...process.env, PANTRY_IDENTITY_FINGERPRINT: fingerprint, PANTRY_P12_PASSWORD: options.password, PANTRY_P12_OUTPUT: output } }))
  if (!existsSync(output)) throw new Error('Security.framework did not export the requested identity')
  chmodSync(output, 0o600)
  return output
}
