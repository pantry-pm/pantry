import type { Platform } from './types'
import * as fs from 'node:fs'
import * as path from 'node:path'

export function ensurePackageExecutorAliases(dir: string, platform: Platform): void {
  const pantryBinary = path.join(dir, platform.binaryName)

  for (const alias of ['panx', 'pnx']) {
    const aliasPath = path.join(dir, platform.os === 'windows' ? `${alias}.exe` : alias)
    try {
      fs.unlinkSync(aliasPath)
    }
    catch {}

    if (platform.os === 'windows')
      fs.copyFileSync(pantryBinary, aliasPath)
    else
      fs.symlinkSync(platform.binaryName, aliasPath)
  }
}
