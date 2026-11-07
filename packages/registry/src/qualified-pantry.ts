/** Restore only the provisioner's own cached CLI; explicit executables stay caller-owned. */
export async function ensureQualifiedPantry(options: {
  executable: string
  expectedVersion: string
  cwd: string
  externallyManaged?: boolean
  install: () => Promise<void>
}): Promise<void> {
  const probe = () => {
    try {
      const result = Bun.spawnSync([options.executable, '--version'], { cwd: options.cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10000 })
      const actual = result.stdout.toString().trim()
      return { valid: result.exitCode === 0 && actual === options.expectedVersion, actual: actual.slice(0, 160) || 'unavailable' }
    }
    catch { return { valid: false, actual: 'unavailable' } }
  }
  let current = probe()
  if (current.valid) return
  if (options.externallyManaged) throw new Error(`The declared Pantry executable must be ${options.expectedVersion}; got ${current.actual}`)
  await options.install()
  current = probe()
  if (!current.valid) throw new Error(`Registry provisioning requires ${options.expectedVersion}; got ${current.actual}`)
}
