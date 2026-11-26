import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

/**
 * Delete a build tree completely, or throw.
 *
 * Go keeps its module cache read-only, and a build's GOPATH lives under its
 * build directory. `rm -rf` on such a tree printed a permission error for every
 * cached file, overflowed execSync's output buffer (ENOBUFS), and the caller
 * only warned: casdoor 4.29.0 then extracted over 4.30.0's leftovers and failed
 * on declarations its own tag does not contain.
 */
export function removeTree(path: string): void {
  if (!existsSync(path)) return
  try {
    rmSync(path, { recursive: true, force: true })
    return
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error
  }
  spawnSync('chmod', ['-R', 'u+w', path], { stdio: 'ignore' })
  rmSync(path, { recursive: true, force: true })
  if (existsSync(path)) throw new Error(`Could not remove ${path}`)
}
