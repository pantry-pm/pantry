export function selectSystemPackages(explicitPackages: string, setupOnly: boolean, detectedPackages: () => string[]): string[] {
  const explicit = explicitPackages.split(/\s+/).filter(Boolean)
  if (explicit.length) return explicit
  return setupOnly ? [] : detectedPackages()
}

export function shouldInstallWorkspace(explicitPackages: string, setupOnly: boolean): boolean {
  return !setupOnly && explicitPackages.trim().length === 0
}
