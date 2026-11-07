import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Package bytes may be cached; a previous setup still owns its command selection. */
export async function preserveCommandActivations<T>(binDir: string, restore: () => Promise<T>): Promise<T> {
  if (!existsSync(binDir)) return restore()
  const metadata = lstatSync(binDir)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Project command directory must be a real directory: ${binDir}`)
  const owned = mkdtempSync(join(tmpdir(), 'pantry-action-activations-'))
  const snapshot = join(owned, 'bin')
  try {
    cpSync(binDir, snapshot, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
    try {
      return await restore()
    }
    finally {
      // A partial cache extraction can also replace activations. Restore these
      // before propagating its error and before selecting newly requested roots.
      const restored = lstatSync(binDir)
      if (!restored.isDirectory() || restored.isSymbolicLink()) throw new Error(`Cached command directory is invalid: ${binDir}`)
      for (const entry of readdirSync(snapshot)) {
        const target = join(binDir, entry)
        rmSync(target, { recursive: true, force: true })
        cpSync(join(snapshot, entry), target, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
      }
    }
  }
  finally {
    rmSync(owned, { recursive: true, force: true })
  }
}
