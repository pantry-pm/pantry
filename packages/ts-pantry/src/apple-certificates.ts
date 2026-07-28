import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface MacCertificateRequestOptions {
  outputDirectory: string
  commonName: string
}

export interface MacCertificateRequest {
  type: 'MAC_APP_DISTRIBUTION' | 'MAC_INSTALLER_DISTRIBUTION'
  keyPath: string
  csrPath: string
}

export interface AppleCertificateP12Options {
  certificatePath: string
  privateKeyPath: string
  outputPath: string
  password: string
  name: string
}

function runOpenSsl(args: string[], env?: NodeJS.ProcessEnv): void {
  const result = spawnSync('openssl', args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error)
    throw new Error(`[pantry] openssl could not be started: ${result.error.message}`)
  if (result.status !== 0)
    throw new Error(`[pantry] openssl ${args[0]} failed: ${result.stderr.trim() || `exit code ${result.status}`}`)
}

/** Generate private keys and CSRs for the two Mac App Store certificate types. */
export function generateMacCertificateRequests(options: MacCertificateRequestOptions): MacCertificateRequest[] {
  const outputDirectory = resolve(options.outputDirectory)
  mkdirSync(outputDirectory, { recursive: true })
  const requests: Array<{
    type: MacCertificateRequest['type']
    fileName: string
    label: string
  }> = [
    {
      type: 'MAC_APP_DISTRIBUTION',
      fileName: 'mac-app-distribution',
      label: 'Mac App Distribution',
    },
    {
      type: 'MAC_INSTALLER_DISTRIBUTION',
      fileName: 'mac-installer-distribution',
      label: 'Mac Installer Distribution',
    },
  ]

  return requests.map((request) => {
    const keyPath = join(outputDirectory, `${request.fileName}.key`)
    const csrPath = join(outputDirectory, `${request.fileName}.csr`)
    if (existsSync(keyPath) || existsSync(csrPath))
      throw new Error(`[pantry] refusing to replace existing Apple certificate material: ${keyPath}`)
    runOpenSsl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-subj',
      `/CN=${`${options.commonName} ${request.label}`.replaceAll('/', '-')}`,
      '-keyout',
      keyPath,
      '-out',
      csrPath,
    ])
    chmodSync(keyPath, 0o600)
    chmodSync(csrPath, 0o600)
    return { type: request.type, keyPath, csrPath }
  })
}

/** Combine an Apple-issued certificate and its private key into a CI-ready P12. */
export function exportAppleCertificateP12(options: AppleCertificateP12Options): string {
  const certificatePath = resolve(options.certificatePath)
  const privateKeyPath = resolve(options.privateKeyPath)
  const outputPath = resolve(options.outputPath)
  if (!existsSync(certificatePath))
    throw new Error(`[pantry] Apple certificate does not exist: ${certificatePath}`)
  if (!existsSync(privateKeyPath))
    throw new Error(`[pantry] certificate private key does not exist: ${privateKeyPath}`)

  const pemPath = `${certificatePath}.pantry.pem`
  try {
    try {
      runOpenSsl(['x509', '-inform', 'DER', '-in', certificatePath, '-out', pemPath])
    }
    catch {
      runOpenSsl(['x509', '-inform', 'PEM', '-in', certificatePath, '-out', pemPath])
    }
    runOpenSsl([
      'pkcs12',
      '-export',
      '-inkey',
      privateKeyPath,
      '-in',
      pemPath,
      '-name',
      options.name,
      '-out',
      outputPath,
      '-passout',
      'env:PANTRY_APPLE_P12_PASSWORD',
    ], {
      ...process.env,
      PANTRY_APPLE_P12_PASSWORD: options.password,
    })
    chmodSync(outputPath, 0o600)
    return outputPath
  }
  finally {
    rmSync(pemPath, { force: true })
  }
}
