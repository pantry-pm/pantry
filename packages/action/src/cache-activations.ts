import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Node's cpSync rejects a standalone dangling symlink even with dereference
// disabled. Relative command links are intentionally dangling inside a private
// snapshot; preserve their link text without asking the runtime to follow it.
function copyActivation(source: string, target: string): void {
  if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), target, 'file')
  else cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
}

/** Package bytes may be cached; a previous setup still owns its command selection. */
export async function preserveCommandActivations<T>(binDir: string, restore: () => Promise<T>): Promise<T> {
  if (!existsSync(binDir)) return restore()
  const metadata = lstatSync(binDir)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Project command directory must be a real directory: ${binDir}`)
  const owned = mkdtempSync(join(tmpdir(), 'pantry-action-activations-'))
  const snapshot = join(owned, 'bin')
  try {
    mkdirSync(snapshot)
    for (const entry of readdirSync(binDir)) copyActivation(join(binDir, entry), join(snapshot, entry))
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
        copyActivation(join(snapshot, entry), target)
      }
    }
  }
  finally {
    rmSync(owned, { recursive: true, force: true })
  }
}
