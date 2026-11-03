import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const recipesDir = join(import.meta.dir, '..', 'src', 'recipes')
const packagesDir = join(import.meta.dir, '..', 'src', 'packages')

function walk(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory())
      found.push(...walk(full))
    else if (entry.name.endsWith('.ts'))
      found.push(full)
  }
  return found
}

/** The `name:` a recipe or generated package declares, if it declares one. */
export function declaredName(source: string): string | null {
  return /^\s{2}name: '((?:[^'\\]|\\.)*)'/m.exec(source)?.[1] ?? null
}

// A moustache token is expanded for build scripts, env, working directories
// and props — never for a package's name, which is why `apu-{{ version.major
// }}-config` reached the catalog, the Zig bundle and every generated commit
// message as that literal text. `programs` is deliberately not checked here:
// python.org and tcl.tk version-stamp their executables the same way on
// purpose, and those names are resolved against the installed tree.
test('no package names a template it will never expand', () => {
  const offenders: string[] = []
  for (const file of [...walk(recipesDir), ...walk(packagesDir)]) {
    const name = declaredName(readFileSync(file, 'utf-8'))
    if (name && name.includes('{{'))
      offenders.push(`${file.slice(file.indexOf('/src/') + 1)}: ${name}`)
  }
  expect(offenders).toEqual([])
})

test('the check recognises the shape that got through', () => {
  expect(declaredName("  name: 'apu-{{ version.major }}-config',")).toBe('apu-{{ version.major }}-config')
  expect(declaredName("  name: 'apr-util' as const,")).toBe('apr-util')
  expect(declaredName("  name: 'tcl',")).toBe('tcl')
  // Not a package name: a nested or differently indented key must not match.
  expect(declaredName("      name: 'inner {{ x }}',")).toBeNull()
})
