import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as exec from '@actions/exec'
import { sha256File } from './release-manifest'

export interface AppStoreReleaseOptions {
  package: string
  bundleId?: string
  version?: string
  buildNumber?: string
  sourceRevision?: string
  apiKeyId: string
  issuerId: string
  privateKey: string
  validateOnly: boolean
  retryExisting: boolean
  dryRun: boolean
}

export interface AppStoreReleaseReceipt {
  schemaVersion: 1
  package: string
  bundleId?: string
  version?: string
  buildNumber?: string
  sourceRevision?: string
  size: number
  sha256: string
  validated: boolean
  uploaded: boolean
  validateOnly: boolean
  dryRun: boolean
  deliveryId?: string
  completedAt: string
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface AppStoreDependencies {
  platform?: NodeJS.Platform
  runCommand?: (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<CommandResult>
  now?: () => string
}

export function parseAppStoreDeliveryId(output: string): string | undefined {
  return output.match(/(?:RequestUUID|delivery(?:\s+id)?|id)\s*[:=]\s*["']?([0-9a-f-]{16,})/i)?.[1]
}

export function isExistingAppStoreUpload(output: string): boolean {
  return /bundle version.*already (?:been )?uploaded|build.*already exists|duplicate upload/i.test(output)
}

async function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  let stdout = ''
  let stderr = ''
  const exitCode = await exec.exec(command, args, {
    env: env
      ? Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
      : undefined,
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

export async function deliverReleaseToAppStore(
  options: AppStoreReleaseOptions,
  dependencies: AppStoreDependencies = {},
): Promise<AppStoreReleaseReceipt> {
  const platform = dependencies.platform || process.platform
  if (!options.dryRun && platform !== 'darwin')
    throw new Error('Mac App Store delivery requires a macOS runner')
  if (!options.package || !fs.existsSync(options.package))
    throw new Error(`Mac App Store package does not exist: ${options.package || '(not set)'}`)
  if (path.extname(options.package).toLowerCase() !== '.pkg')
    throw new Error('Mac App Store delivery requires a signed .pkg artifact')
  if (!options.dryRun && (!options.apiKeyId || !options.issuerId || !options.privateKey))
    throw new Error('Mac App Store delivery requires API key ID, issuer ID, and private key')

  const command = dependencies.runCommand || runCommand
  const receipt: AppStoreReleaseReceipt = {
    schemaVersion: 1,
    package: path.basename(options.package),
    ...(options.bundleId ? { bundleId: options.bundleId } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(options.buildNumber ? { buildNumber: options.buildNumber } : {}),
    ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    size: fs.statSync(options.package).size,
    sha256: sha256File(options.package),
    validated: false,
    uploaded: false,
    validateOnly: options.validateOnly,
    dryRun: options.dryRun,
    completedAt: (dependencies.now || (() => new Date().toISOString()))(),
  }

  if (options.dryRun)
    return receipt

  assertSucceeded('Package signature verification', await command('pkgutil', ['--check-signature', options.package]))

  const credentialsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-app-store-'))
  const privateKeysDirectory = path.join(credentialsDirectory, 'private_keys')
  fs.mkdirSync(privateKeysDirectory, { mode: 0o700 })
  const keyFile = path.join(privateKeysDirectory, `AuthKey_${options.apiKeyId}.p8`)
  fs.writeFileSync(keyFile, options.privateKey.endsWith('\n') ? options.privateKey : `${options.privateKey}\n`, { mode: 0o600 })
  const env = { ...process.env, API_PRIVATE_KEYS_DIR: privateKeysDirectory }
  const authArgs = ['--apiKey', options.apiKeyId, '--apiIssuer', options.issuerId]

  try {
    const validation = await command('xcrun', [
      'altool',
      '--validate-app',
      '-f',
      options.package,
      '-t',
      'macos',
      ...authArgs,
    ], env)
    assertSucceeded('App Store validation', validation)
    receipt.validated = true

    if (!options.validateOnly) {
      const upload = await command('xcrun', [
        'altool',
        '--upload-app',
        '-f',
        options.package,
        '-t',
        'macos',
        ...authArgs,
      ], env)
      const output = `${upload.stdout}\n${upload.stderr}`
      if (upload.exitCode !== 0 && !(options.retryExisting && isExistingAppStoreUpload(output)))
        assertSucceeded('App Store upload', upload)
      receipt.uploaded = upload.exitCode === 0 || isExistingAppStoreUpload(output)
      receipt.deliveryId = parseAppStoreDeliveryId(output)
    }

    return receipt
  }
  finally {
    fs.rmSync(credentialsDirectory, { recursive: true, force: true })
  }
}
