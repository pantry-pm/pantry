import type { NativeCommand } from './command'
import process from 'node:process'
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runNativeCommand, succeeded } from './command'

/** Sign AABs without exposing keystores or passwords in command arguments. */
export async function signNativeAndroidBundle(bundle: string, env: NodeJS.ProcessEnv = process.env, command: NativeCommand = runNativeCommand): Promise<void> {
  if (!bundle.endsWith('.aab') || !existsSync(bundle)) throw new Error('Android signing requires an existing .aab')
  const credentials = [env.ANDROID_KEYSTORE_BASE64, env.ANDROID_KEYSTORE_PASSWORD, env.ANDROID_KEY_ALIAS, env.ANDROID_KEY_PASSWORD]
  if (credentials.some(Boolean) && !credentials.every(Boolean)) throw new Error('Android signing requires a keystore, alias, store password and key password')
  const directory = mkdtempSync(join(tmpdir(), 'pantry-android-signing-'))
  const signed = `${bundle}.pantry-signed.aab`
  const verify = async (file: string) => {
    const result = succeeded('Android bundle signature', await command('jarsigner', ['-J-Duser.language=en', '-J-Duser.country=US', '-verify', file]))
    if (!/jar verified\./i.test(result.stdout) || /jar is unsigned/i.test(`${result.stdout}${result.stderr}`)) throw new Error('Android bundle is not signed')
  }
  try {
    if (credentials.every(Boolean)) {
      if (existsSync(signed)) throw new Error('A previous Android signing artifact still exists')
      const keystore = join(directory, 'release.keystore')
      writeFileSync(keystore, Buffer.from(env.ANDROID_KEYSTORE_BASE64!, 'base64'), { mode: 0o600 })
      succeeded('Android bundle signing', await command('jarsigner', ['-J-Duser.language=en', '-J-Duser.country=US', '-keystore', keystore, '-storepass:env', 'PANTRY_ANDROID_STORE_PASSWORD', '-keypass:env', 'PANTRY_ANDROID_KEY_PASSWORD', '-signedjar', signed, bundle, env.ANDROID_KEY_ALIAS!], { env: { ...env, PANTRY_ANDROID_STORE_PASSWORD: env.ANDROID_KEYSTORE_PASSWORD, PANTRY_ANDROID_KEY_PASSWORD: env.ANDROID_KEY_PASSWORD } }))
      await verify(signed)
      renameSync(signed, bundle)
    }
    else await verify(bundle)
  }
  finally {
    rmSync(signed, { force: true })
    rmSync(directory, { recursive: true, force: true })
  }
}
