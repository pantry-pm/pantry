import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { removeAppleSigningKeychain } from './apple-signing'

async function stopRedis(): Promise<void> {
  if (core.getState('redis-started') !== 'true') return
  const client = core.getState('redis-cli')
  if (!client) return
  await exec.exec(client, ['-h', '127.0.0.1', '-p', '6379', 'shutdown', 'nosave'], { silent: true }).catch(() => {})
  core.info('Stopped Pantry Redis service')
}

async function removeSigningKeychain(): Promise<void> {
  const keychainPath = core.getState('apple-signing-keychain')
  if (!keychainPath) return
  await removeAppleSigningKeychain(keychainPath)
  core.info('Removed Apple signing keychain')
}

async function cleanup(): Promise<void> {
  // Each step is independent — failing to stop Redis must not leave the signing
  // certificates behind on the runner.
  for (const step of [stopRedis, removeSigningKeychain])
    await step().catch(error => core.warning(error instanceof Error ? error.message : String(error)))
}

cleanup().catch(error => core.warning(error instanceof Error ? error.message : String(error)))
