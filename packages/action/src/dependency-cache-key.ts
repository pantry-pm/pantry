import type { Platform } from './types'

/** Reconcile with the current CLI after restoring identical native artifacts. */
export function dependencyCacheKeys(
  platform: Platform,
  artifactIdentity: string,
  cliVersion: string,
  lockHash: string,
  depsHash: string,
  packages: string,
): { key: string, restoreKeys: string[] } {
  const prefix = `pantry-native-v1-${platform.os}-${platform.arch}-${artifactIdentity}-`
  return {
    key: `${prefix}${cliVersion}-${lockHash}-${depsHash}-${packages || 'all'}`,
    // Whole-tree v4/v5 archives include workspace source and are not this
    // payload format. Every compatible prefix retains the artifact digest so
    // rebuilt packages never restore old bytes. CLI patch releases alone do not require re-downloading
    // the entire toolchain. A prefix hit runs the normal install reconciliation.
    restoreKeys: [
      `${prefix}${cliVersion}-`,
      prefix,
    ],
  }
}
