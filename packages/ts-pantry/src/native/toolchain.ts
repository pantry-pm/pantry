import type { NativeCommand } from './command'
import { version as sdkVersion } from '../../package.json'
import { resolveVersionFromMetadata } from '../version-utils'

// Validate complete version text before the tolerant registry resolver sees it.
// Ordering and caret compatibility remain owned by version-utils, not this
// branded-output check. The native SDK also runs on Node, without a Bun global.
const number = '(?:0|[1-9]\\d*)'
const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const version = `${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`
const completeVersion = new RegExp(`^${version}$`)
const pantryVersion = new RegExp(`^pantry\\s+(${version})(?:\\s+\\([^\\r\\n()]+\\))?$`)
if (!completeVersion.test(sdkVersion)) throw new Error('The native SDK requires a valid paired Pantry SDK/CLI version')

/** Native provisioning supports the compatible CLI cohort at or above this SDK. */
export const nativePantryCliRange: string = `^${sdkVersion}`

/** Probe the same bare command, cwd and complete environment used for install. */
export async function requireNativePantryCli(command: NativeCommand, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const required = `ts-pantry@${sdkVersion} native provisioning requires Pantry ${nativePantryCliRange} on PATH in ${cwd}.`
  const recovery = 'Install or upgrade the Pantry CLI on that PATH before retrying.'
  let result
  try {
    result = await command('pantry', ['--version'], { cwd, env, timeoutMs: 10_000 })
  }
  catch (cause) {
    throw new Error(`${required} Could not run \`pantry --version\`. ${recovery}`, { cause })
  }
  if (result.exitCode !== 0) throw new Error(`${required} \`pantry --version\` exited ${result.exitCode}. ${recovery}`)
  const found = pantryVersion.exec(result.stdout.trim() || result.stderr.trim())?.[1]
  if (!found) throw new Error(`${required} \`pantry --version\` returned an invalid native CLI version. ${recovery}`)
  if (resolveVersionFromMetadata(nativePantryCliRange, [found]) !== found)
    throw new Error(`${required} Found ${found}. ${recovery}`)
}
