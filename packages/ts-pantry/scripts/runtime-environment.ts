/** Package-declared defaults are literal strings with a relocatable prefix token. */
export type RuntimeEnvironment = Readonly<Record<string, string>>

function validateVariable(name: string, value: unknown): asserts value is string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error(`Invalid package runtime variable: ${name}`)
  if (typeof value !== 'string' || value.includes('\0'))
    throw new Error(`Invalid package runtime value: ${name}`)
}

/** Expand only the package prefix; never evaluate package data as shell code. */
export function resolveRuntimeEnvironment(environment: RuntimeEnvironment | undefined, prefix: string): Record<string, string> {
  if (prefix.includes('\0')) throw new Error('Invalid package runtime prefix')
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment ?? {})) {
    validateVariable(name, value)
    const remaining = value.replace(/\$?\{\{prefix\}\}/g, '')
    if (remaining.includes('{{') || remaining.includes('}}'))
      throw new Error(`Unsupported package runtime placeholder: ${name}`)
    const expanded = value.replace(/\$?\{\{prefix\}\}/g, () => prefix)
    Object.defineProperty(result, name, { value: expanded, enumerable: true, configurable: true, writable: true })
  }
  return result
}

/** POSIX defaults retain an explicit nonempty caller value and quote all literals. */
export function runtimeEnvironmentScript(environment: RuntimeEnvironment): string {
  const lines: string[] = []
  for (const [name, value] of Object.entries(environment)) {
    validateVariable(name, value)
    const literal = `'${value.replaceAll("'", "'\\''")}'`
    lines.push(`if [ -z "\${${name}:-}" ]; then export ${name}=${literal}; fi`)
  }
  return lines.join('\n')
}

/** Resolve the actual selected versions, including isolated build-tool closures. */
export async function dependencyRuntimeEnvironment(
  paths: Readonly<Record<string, string>>,
  load: (domain: string, version: string) => Promise<RuntimeEnvironment | undefined>,
): Promise<Record<string, string>> {
  const environment: Record<string, string> = {}
  const owners = new Map<string, string>()
  const visited = new Set<string>()
  for (const [key, prefix] of Object.entries(paths)) {
    if (!key.endsWith('.prefix')) continue
    const selected = key.startsWith('deps.') ? key.slice(5, -7)
      : key.startsWith('build-tools.') ? key.slice(12, -7).split(':')[1] : undefined
    if (!selected) continue
    const domain = selected.split('@')[0]!
    const version = paths[`${key.slice(0, -7)}.version`]
    if (!version) throw new Error(`Missing selected runtime version: ${key}`)
    const identity = `${domain}@${version}:${prefix}`
    if (visited.has(identity)) continue
    visited.add(identity)
    const resolved = resolveRuntimeEnvironment(await load(domain, version), prefix)
    for (const [name, value] of Object.entries(resolved)) {
      if (Object.hasOwn(environment, name) && environment[name] !== value)
        throw new Error(`Conflicting package runtime variable ${name}: ${owners.get(name)} and ${domain}@${version}`)
      Object.defineProperty(environment, name, { value, enumerable: true, configurable: true, writable: true })
      owners.set(name, `${domain}@${version}`)
    }
  }
  return environment
}
