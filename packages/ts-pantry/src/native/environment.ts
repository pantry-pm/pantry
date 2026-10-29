import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getEnv, resolveEnvPrivateKey } from '@stacksjs/env/cli'
import { isValidPublicKey, publicKeyMatchesPrivateKey } from '@stacksjs/env/crypto'
import { parse } from '@stacksjs/env/parser'
import { plaintextSecrets } from '@stacksjs/env/plaintext'

/** Validate committed ciphertext even in CI jobs that have no decryption key. */
export function auditNativeEnvironment(root: string, environment: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(environment)) throw new Error('Invalid native release environment name')
  const file = join(root, `.env.${environment}`)
  if (!existsSync(file)) throw new Error(`Native release environment is missing: .env.${environment}`)
  const { parsed, skippedEncrypted } = parse(readFileSync(file, 'utf8'), { processEnv: {} })
  if ([...Object.keys(parsed), ...skippedEncrypted].some(key => key.startsWith('DOTENV_PRIVATE_KEY'))) throw new Error('Private decryption keys must never be committed in environment files')
  const findings = plaintextSecrets(parsed, { strict: true })
  if (findings.length) throw new Error(`Native release environment must be Buddy-encrypted: ${findings.map(finding => finding.key).join(', ')}`)
  const publicKey = parsed[`DOTENV_PUBLIC_KEY_${environment.toUpperCase()}`] || parsed.DOTENV_PUBLIC_KEY
  if (!isValidPublicKey(publicKey)) throw new Error('Native release environment requires valid Buddy public-key metadata')
}

/** Use the same resolver and atomic whole-file read as buddy env:get. */
export function loadNativeEnvironment(root: string, environment: string, onSecret: (value: string) => void = () => {}): Record<string, string> {
  auditNativeEnvironment(root, environment)
  const file = `.env.${environment}`
  const result = getEnv(undefined, { cwd: root, file, all: true, format: 'json' })
  if (!result.success || !result.output) throw new Error(result.error || `Could not read ${file}`)
  const values = JSON.parse(result.output) as Record<string, string>
  const publicKey = values[`DOTENV_PUBLIC_KEY_${environment.toUpperCase()}`] || values.DOTENV_PUBLIC_KEY
  if (!publicKeyMatchesPrivateKey(publicKey, resolveEnvPrivateKey({ cwd: root, file }))) throw new Error('Native release environment key does not match its public metadata')
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith('DOTENV_PRIVATE_KEY') && value) throw new Error('Private decryption keys must never be committed in environment files')
    if (!key.startsWith('DOTENV_PUBLIC_KEY') && value) onSecret(value)
  }
  return Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith('DOTENV_')))
}
