export function selectSystemPackages(explicitPackages: string, setupOnly: boolean, detectedPackages: () => string[]): string[] {
  const explicit = explicitPackages.split(/\s+/).filter(Boolean)
  if (explicit.length) return explicit
  return setupOnly ? [] : detectedPackages()
}

export function shouldInstallWorkspace(explicitPackages: string, setupOnly: boolean): boolean {
  return !setupOnly && explicitPackages.trim().length === 0
}

export async function installRequiredSystemPackages(
  packages: string[],
  install: (packageSpec: string) => Promise<void>,
): Promise<void> {
  for (const packageSpec of packages) {
    try {
      await install(packageSpec)
    }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Required system package ${packageSpec} failed to install: ${detail}`)
    }
  }
}
