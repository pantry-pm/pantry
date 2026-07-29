import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as exec from '@actions/exec'

/**
 * Apple code signing on a CI runner.
 *
 * `codesign` and `productbuild` read identities from a keychain, but a runner
 * starts with none — so certificates arrive as base64 `.p12` secrets and have
 * to be imported before anything can be signed. This module owns that setup and
 * reports the identity names the packaging step needs.
 */

export interface AppleSigningOptions {
  /** Base64-encoded `.p12` holding the application signing certificate */
  applicationCertificate: string
  /** Base64-encoded `.p12` holding the installer signing certificate */
  installerCertificate?: string
  /** Password protecting both `.p12` files */
  certificatePassword: string
  /** Base64-encoded `.provisionprofile` written to disk for the app bundle */
  provisioningProfile?: string
  /** Directory the profile is written to. Defaults to the runner temp directory. */
  outputDirectory?: string
}

export interface AppleSigningResult {
  /** Path to the temporary keychain holding the imported certificates */
  keychainPath: string
  /** Identity for `codesign`, e.g. "3rd Party Mac Developer Application: Acme (TEAMID)" */
  applicationIdentity: string
  /** Identity for `productbuild`, when an installer certificate was supplied */
  installerIdentity?: string
  /** Path to the written provisioning profile, when one was supplied */
  provisioningProfilePath?: string
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface SigningDependencies {
  platform?: NodeJS.Platform
  runCommand?: (command: string, args: string[]) => Promise<CommandResult>
  /** Directory temporary files are created under. Defaults to the OS temp dir. */
  tempDirectory?: string
}

/**
 * Parse `security find-identity -v` output into identity names.
 *
 * Lines look like:
 * `  1) A1B2C3 "3rd Party Mac Developer Application: Acme (TEAMID)"`
 */
export function parseSigningIdentities(output: string): string[] {
  return [...output.matchAll(/^\s*\d+\)\s+[0-9A-F]+\s+"([^"]+)"/gim)].map(match => match[1])
}

/**
 * Pick the identity matching a certificate kind. Apple's naming is stable
 * enough to match on prefix, and being explicit about which kinds count as
 * "application" vs "installer" avoids signing a package with an app certificate.
 */
export function selectSigningIdentity(identities: string[], kind: 'application' | 'installer'): string | undefined {
  const prefixes = kind === 'application'
    ? ['3rd Party Mac Developer Application', 'Apple Distribution', 'Developer ID Application']
    : ['3rd Party Mac Developer Installer', 'Developer ID Installer']

  for (const prefix of prefixes) {
    const match = identities.find(identity => identity.startsWith(prefix))
    if (match)
      return match
  }
  return undefined
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  let stdout = ''
  let stderr = ''
  const exitCode = await exec.exec(command, args, {
    ignoreReturnCode: true,
    silent: true,
    listeners: {
      stdout: (data: Buffer) => { stdout += data.toString() },
      stderr: (data: Buffer) => { stderr += data.toString() },
    },
  })
  return { exitCode, stdout, stderr }
}

function assertSucceeded(label: string, result: CommandResult): void {
  if (result.exitCode === 0)
    return
  const output = `${result.stdout}\n${result.stderr}`.trim()
  throw new Error(`${label} failed${output ? `: ${output}` : ` with exit code ${result.exitCode}`}`)
}

function decodeToFile(directory: string, name: string, base64: string): string {
  const filePath = path.join(directory, name)
  fs.writeFileSync(filePath, Buffer.from(base64.trim(), 'base64'), { mode: 0o600 })
  return filePath
}

/**
 * Import Apple signing certificates into a throwaway keychain and report the
 * identities they provide. Call `removeAppleSigningKeychain` when the job ends.
 */
export async function setupAppleSigning(
  options: AppleSigningOptions,
  dependencies: SigningDependencies = {},
): Promise<AppleSigningResult> {
  const platform = dependencies.platform || process.platform
  if (platform !== 'darwin')
    throw new Error('Apple code signing requires a macOS runner')
  if (!options.applicationCertificate)
    throw new Error('Apple code signing requires an application certificate')
  if (!options.certificatePassword)
    throw new Error('Apple code signing requires the password protecting the .p12 certificates')

  const command = dependencies.runCommand || runCommand
  const workDirectory = fs.mkdtempSync(path.join(dependencies.tempDirectory || os.tmpdir(), 'pantry-signing-'))

  // A per-run password means the keychain is useless to anything that manages
  // to read it after the job, and never collides with the runner's own.
  const keychainPassword = crypto.randomBytes(24).toString('base64')
  const keychainPath = path.join(workDirectory, 'pantry-signing.keychain-db')

  assertSucceeded('Keychain creation', await command('security', ['create-keychain', '-p', keychainPassword, keychainPath]))
  // Without this the keychain re-locks mid-build and signing fails partway.
  assertSucceeded('Keychain configuration', await command('security', ['set-keychain-settings', '-lut', '21600', keychainPath]))
  assertSucceeded('Keychain unlock', await command('security', ['unlock-keychain', '-p', keychainPassword, keychainPath]))

  const certificates = [
    { name: 'application.p12', content: options.applicationCertificate },
    ...(options.installerCertificate ? [{ name: 'installer.p12', content: options.installerCertificate }] : []),
  ]
  for (const certificate of certificates) {
    const certificatePath = decodeToFile(workDirectory, certificate.name, certificate.content)
    assertSucceeded(`Import of ${certificate.name}`, await command('security', [
      'import', certificatePath,
      '-k', keychainPath,
      '-P', options.certificatePassword,
      '-T', '/usr/bin/codesign',
      '-T', '/usr/bin/productbuild',
      '-f', 'pkcs12',
      // Signing tools need the key without a per-use prompt no runner can answer.
      '-A',
    ]))
    fs.rmSync(certificatePath, { force: true })
  }

  // codesign asks the keychain for the key non-interactively; without this ACL
  // the request blocks on a UI prompt and the job hangs until it times out.
  assertSucceeded('Keychain partition list', await command('security', [
    'set-key-partition-list',
    '-S', 'apple-tool:,apple:,codesign:',
    '-s',
    '-k', keychainPassword,
    keychainPath,
  ]))

  // Put the keychain on the search list so the signing tools actually see it.
  const searchList = await command('security', ['list-keychains', '-d', 'user'])
  assertSucceeded('Keychain search list', searchList)
  const existing = [...searchList.stdout.matchAll(/"([^"]+)"/g)].map(match => match[1])
  assertSucceeded('Keychain search list update', await command('security', [
    'list-keychains', '-d', 'user', '-s', keychainPath, ...existing,
  ]))

  const found = await command('security', ['find-identity', '-v', keychainPath])
  assertSucceeded('Identity lookup', found)
  const identities = parseSigningIdentities(found.stdout)

  const applicationIdentity = selectSigningIdentity(identities, 'application')
  if (!applicationIdentity)
    throw new Error(`No application signing identity found in the imported certificates (found: ${identities.join(', ') || 'none'})`)

  const installerIdentity = selectSigningIdentity(identities, 'installer')
  if (options.installerCertificate && !installerIdentity)
    throw new Error(`No installer signing identity found in the imported certificates (found: ${identities.join(', ')})`)

  const provisioningProfilePath = options.provisioningProfile
    ? decodeToFile(options.outputDirectory || workDirectory, 'embedded.provisionprofile', options.provisioningProfile)
    : undefined

  return {
    keychainPath,
    applicationIdentity,
    ...(installerIdentity ? { installerIdentity } : {}),
    ...(provisioningProfilePath ? { provisioningProfilePath } : {}),
  }
}

/** Drop the temporary keychain from the search list and delete it. */
export async function removeAppleSigningKeychain(
  keychainPath: string,
  dependencies: SigningDependencies = {},
): Promise<void> {
  const command = dependencies.runCommand || runCommand
  await command('security', ['delete-keychain', keychainPath])
  fs.rmSync(path.dirname(keychainPath), { recursive: true, force: true })
}
