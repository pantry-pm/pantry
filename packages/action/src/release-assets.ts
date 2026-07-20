import path from 'node:path'

const archiveExtensions = ['.tar.gz', '.zip', '.tgz'] as const

/**
 * Resolve the release-files input. `null` means auto-package build output,
 * while an empty array explicitly requests a notes-only release.
 */
export function resolveReleaseFilePatterns(input: string): string[] | null {
  const patterns = input.split('\n').map(pattern => pattern.trim()).filter(Boolean)

  if (patterns.length === 0 || (patterns.length === 1 && patterns[0] === 'auto'))
    return null

  if (patterns.length === 1 && patterns[0] === 'none')
    return []

  return patterns
}

function archiveKey(file: string): string | undefined {
  const name = path.basename(file)
  const extension = archiveExtensions.find(candidate => name.endsWith(candidate))
  return extension ? path.join(path.dirname(file), name.slice(0, -extension.length)) : undefined
}

function binaryKey(file: string): string {
  const name = path.basename(file)
  const stem = name.endsWith('.exe') ? name.slice(0, -'.exe'.length) : name
  return path.join(path.dirname(file), stem)
}

/**
 * Prefer packaged release assets whenever both an archive and its raw binary
 * are present. Other explicit assets, such as checksums and installers, remain
 * untouched.
 */
export function preferArchivedReleaseAssets(files: string[]): string[] {
  const uniqueFiles = Array.from(new Set(files))
  const archivedKeys = new Set(
    uniqueFiles
      .map(archiveKey)
      .filter((key): key is string => Boolean(key)),
  )

  return uniqueFiles.filter(file => archiveKey(file) !== undefined || !archivedKeys.has(binaryKey(file)))
}

/** Raw release asset names superseded by the supplied archives. */
export function rawAssetNamesForArchives(files: string[]): Set<string> {
  const names = new Set<string>()
  for (const file of files) {
    const key = archiveKey(file)
    if (!key)
      continue

    const stem = path.basename(key)
    names.add(stem)
    names.add(`${stem}.exe`)
  }
  return names
}
