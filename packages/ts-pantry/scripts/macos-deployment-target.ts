import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDynamicMachO } from './macho'

function version(value: unknown): number[] {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(value))
    throw new Error(`Invalid macOS deployment version: ${String(value)}`)
  const parts = value.split('.').map(Number)
  if (parts.some(part => !Number.isSafeInteger(part)) || parts[0] < 1)
    throw new Error(`Invalid macOS deployment version: ${value}`)
  return parts
}

/** Read every architecture, including legacy load commands; SDK versions are not deployment minima. */
export function macOSMinimumVersions(output: string): string[] {
  const slices = output.split(/^(?=\S.*:\s*$)/m).filter(part => part.trim())
  if (!slices.length) throw new Error('Missing Mach-O load commands')
  const minima: string[] = []
  for (const slice of slices) {
    let metadata = false
    for (const command of slice.split(/^Load command \d+\s*$/m).slice(1)) {
      const kind = command.match(/^\s*cmd (\S+)\s*$/m)?.[1]
      if (kind === 'LC_BUILD_VERSION') {
        const platform = command.match(/^\s*platform (\S+)\s*$/m)?.[1]
        const minimum = command.match(/^\s*minos (\S+)\s*$/m)?.[1]
        version(minimum)
        if (!platform || !/^(?:[1-9]|1[0-6]|MACOS|IOS|TVOS|WATCHOS|BRIDGEOS|MACCATALYST|IOSSIMULATOR|TVOSSIMULATOR|WATCHOSSIMULATOR|DRIVERKIT|XROS|XROSSIMULATOR)$/.test(platform))
          throw new Error('Invalid Mach-O build platform')
        if (platform === '1' || platform === 'MACOS') minima.push(minimum!)
        metadata = true
      }
      else if (kind === 'LC_VERSION_MIN_MACOSX') {
        const minimum = command.match(/^\s*version (\S+)\s*$/m)?.[1]
        version(minimum)
        minima.push(minimum!)
        metadata = true
      }
      else if (kind && /^LC_VERSION_MIN_(?:IPHONEOS|TVOS|WATCHOS)$/.test(kind)) {
        version(command.match(/^\s*version (\S+)\s*$/m)?.[1])
        metadata = true
      }
    }
    if (!metadata) throw new Error('Missing Mach-O deployment metadata for an architecture')
  }
  return minima
}

/** Enforce an explicitly declared recipe baseline after relocation and before publication. */
export function verifyMacOSDeploymentTarget(
  prefix: string,
  target: unknown,
  readLoadCommands: (path: string) => string = path => execFileSync('otool', ['-l', path], { encoding: 'utf8' }),
): string[] {
  const baseline = version(target)
  const checked: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && isDynamicMachO(path)) {
        try {
          for (const minimum of macOSMinimumVersions(readLoadCommands(path))) {
            const actual = version(minimum)
            const difference = [0, 1, 2].map(index => (actual[index] ?? 0) - (baseline[index] ?? 0)).find(part => part !== 0) ?? 0
            if (difference > 0)
              throw new Error(`requires macOS ${minimum}, newer than declared ${String(target)}`)
          }
          checked.push(path)
        }
        catch (error) {
          throw new Error(`Cannot qualify ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
      }
    }
  }
  walk(prefix)
  return checked
}
