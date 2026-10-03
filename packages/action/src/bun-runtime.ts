import * as fs from 'node:fs'
import * as path from 'node:path'

export interface BunRuntimeSetup {
  /** Installs `bun.sh` into the pantry directory; rejects when it cannot. */
  install: () => Promise<void>
  /** `pantry/.bin`, where the installer links the `bun` executable. */
  binDir: string
  /** Called with the pantry directory once `bun` is linked (sets BUN_INSTALL). */
  onLinked?: () => void
}

/**
 * Provide the Bun runtime the action promises even with `install: false`.
 *
 * Bun is a REQUIRED part of that contract, so a failed install has to fail
 * the setup step right here, carrying the download error. Downgrading it to a
 * warning reported a successful setup and deferred the failure to whatever
 * step next ran `bun`, as an unrelated `bun: command not found` (#234).
 *
 * Linking `bunx` stays best-effort: it is a convenience alias, and the
 * runtime itself is already in place by the time it is attempted.
 */
export async function setupBunRuntime({ install, binDir, onLinked }: BunRuntimeSetup): Promise<void> {
  try {
    await install()
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Required runtime bun.sh failed to install: ${detail}`)
  }

  const bunPath = path.join(binDir, 'bun')
  if (!fs.existsSync(bunPath)) return

  const bunxPath = path.join(binDir, 'bunx')
  try { fs.unlinkSync(bunxPath) }
  catch { /* doesn't exist */ }
  try {
    fs.symlinkSync(bunPath, bunxPath)
  }
  catch { /* bunx is an alias; bun itself is installed */ }
  onLinked?.()
}
