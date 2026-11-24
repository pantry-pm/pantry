/**
 * What an installer needs from a version's manifest: its dependencies, bins
 * and platform constraints.
 *
 * A version used to keep only its tarball, checksum and size, so every
 * Pantry-published JavaScript package was served with no dependencies at all:
 * `bun install` through `/npm/` installed `stacks` and nothing it depends on,
 * and the Pantry CLI's own resolver saw the same empty list. The fields are
 * now recorded with each version at publish, read from the `package.json`
 * packed in the published bytes (the manifest the installer extracts), and a
 * version published before this is filled in from its tarball the first time
 * it is read.
 */
import { readPackagedManifests } from './malware-scanning'

export type InstallManifest = Record<string, unknown>

const INSTALL_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'bundledDependencies',
  'bin',
  'directories',
  'engines',
  'os',
  'cpu',
  'libc',
] as const

/** The lifecycle scripts an install runs; the rest of `scripts` is not install metadata. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const

/**
 * The archive's integrity in npm's form (`sha512-<base64>`), recorded with the
 * install fields so a Pantry copy can be compared with npm's copy of the same
 * version: when they differ, npm's is the one lockfiles already name.
 */
export function artifactIntegrity(tarball: ArrayBuffer): string {
  return `sha512-${new Bun.CryptoHasher('sha512').update(tarball).digest('base64')}`
}

/** The install fields of a manifest (an empty object when it has none). */
export function installManifestOf(manifest: unknown): InstallManifest {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return {}
  const source = manifest as Record<string, unknown>
  const install: InstallManifest = {}
  for (const field of INSTALL_FIELDS) {
    if (source[field] !== undefined) install[field] = source[field]
  }
  const scripts = source.scripts
  if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
    const hooks = Object.fromEntries(INSTALL_SCRIPTS
      .filter(name => typeof (scripts as Record<string, unknown>)[name] === 'string')
      .map(name => [name, (scripts as Record<string, unknown>)[name]]))
    if (Object.keys(hooks).length) install.scripts = hooks
  }
  return install
}

/**
 * The install fields of the `package.json` packed in `tarball` for
 * `name@version`, or null when the archive holds no such manifest (a
 * non-JavaScript artifact, or bytes this cannot read).
 */
export function packagedInstallManifest(tarball: ArrayBuffer, name: string, version: string): InstallManifest | null {
  const manifest = readPackagedManifests(tarball).find((candidate) => {
    const fields = candidate as Record<string, unknown> | null
    return !!fields && typeof fields === 'object' && fields.name === name && fields.version === version
  })
  return manifest === undefined ? null : installManifestOf(manifest)
}
