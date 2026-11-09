import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface BunRuntimeSetup {
  /** Installs `bun.sh` into the pantry directory; rejects when it cannot. */
  install: () => Promise<void>
  /** `pantry/.bin`, where the installer links the `bun` executable. */
  binDir: string
  /** Called with the pantry directory once `bun` is linked (sets BUN_INSTALL). */
  onLinked?: () => void
  /** A preceding action already activated this prefix; retain its selected compiler. */
  preserveExisting?: boolean
}

/** Setup-only bootstrap respects the project's Bun declaration without installing other roots. */
export function requiredBunPackageSpec(specs: string[]): string {
  return specs.find(spec => /^(?:bun|bun\.sh|bun\.com)(?:@|$)/.test(spec)) || 'bun.sh'
}

/**
 * Provide the Bun runtime the action promises even with `install: false`.
 *
 * Bun is a REQUIRED part of that contract, so a failed install has to fail
 * the setup step right here, carrying the download error. Downgrading it to a
 * warning reported a successful setup and deferred the failure to whatever
 * step next ran `bun`, as an unrelated `bun: command not found` (#234).
 *
 * Pantry owns the activation of both programs. In particular, `bun` can be
 * a launcher that restores its provider environment. Linking `bunx` to that
 * launcher loses its executor arguments and runs `bun <package>` instead.
 */
export async function setupBunRuntime({ install, binDir, onLinked, preserveExisting }: BunRuntimeSetup): Promise<void> {
  const executable = path.join(binDir, process.platform === 'win32' ? 'bun.exe' : 'bun')
  const bunPath = fs.existsSync(executable) ? executable : path.join(binDir, 'bun')
  if (preserveExisting && fs.existsSync(bunPath)) {
    let available = false
    try {
      const version = execFileSync(bunPath, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
      available = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)
    }
    catch {
      // A missing or broken activation must still be repaired by installation.
    }
    if (available) {
      onLinked?.()
      return
    }
  }
  try {
    await install()
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Required runtime bun.sh failed to install: ${detail}`)
  }

  if (!fs.existsSync(executable) && !fs.existsSync(path.join(binDir, 'bun'))) return

  onLinked?.()
}

/**
 * Where Bun keeps downloaded packages, when the workflow has not chosen.
 *
 * The action points BUN_INSTALL at the checkout's `pantry/` prefix, and Bun's
 * default cache is `$BUN_INSTALL/install/cache`, so every job started with an
 * empty cache inside its fresh checkout and downloaded every package again,
 * GitHub-hosted tarballs included. On a self-hosted runner that is the same
 * dozens of release downloads from one address on every job, enough for
 * GitHub's edge to start answering 504. The runner's home outlives the job,
 * and on a hosted runner the cache simply ends with it.
 */
export function bunInstallCacheDir(env: Record<string, string | undefined>, home: string): string | null {
  if (env.BUN_INSTALL_CACHE_DIR) return null
  return home ? `${home.replace(/[\\/]+$/, '')}/.bun/install/cache` : null
}
