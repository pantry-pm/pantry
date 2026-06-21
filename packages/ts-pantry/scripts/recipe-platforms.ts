#!/usr/bin/env bun
/**
 * Print the registry platform keys (e.g. `darwin-arm64 darwin-x86-64`) a
 * recipe targets, derived from its `platforms` field. Used by
 * build-and-upload.sh so a platform-agnostic desktop/font artifact built on a
 * single runner is registered under every platform key its recipe supports —
 * the Zig CLI's registry lookup only matches the host's own `darwin-<arch>`
 * key, so an artifact uploaded solely under the build host's key (e.g.
 * `linux-x86-64` on the ubuntu runner) would be invisible to macOS clients.
 *
 * Usage: bun scripts/recipe-platforms.ts <domain>
 * Output: space-separated registry platform keys on stdout (empty if unknown).
 */
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RECIPES_DIR = join(__dirname, '..', 'src', 'recipes')

function findRecipeFile(dir: string, filename: string): string | null {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      const hit = findRecipeFile(full, filename)
      if (hit)
        return hit
    }
    else if (name === filename) {
      return full
    }
  }
  return null
}

/** Map a recipe platform token (`darwin/aarch64`) to a registry key (`darwin-arm64`). */
function toRegistryKey(p: string): string | null {
  const [os, arch] = p.split('/')
  const osKey = os === 'darwin' ? 'darwin' : os === 'linux' ? 'linux' : null
  const archKey = (arch === 'aarch64' || arch === 'arm64') ? 'arm64'
    : (arch === 'x86-64' || arch === 'x86_64' || arch === 'amd64') ? 'x86-64'
        : null
  return osKey && archKey ? `${osKey}-${archKey}` : null
}

async function main(): Promise<void> {
  const domain = process.argv[2]
  if (!domain) {
    process.exit(0)
  }
  const file = findRecipeFile(RECIPES_DIR, `${domain}.ts`)
  if (!file) {
    process.exit(0)
  }
  let recipe: { platforms?: string[] }
  try {
    ;({ recipe } = await import(file) as { recipe: { platforms?: string[] } })
  }
  catch {
    process.exit(0)
  }
  const keys = (recipe.platforms ?? [])
    .map(toRegistryKey)
    .filter((k): k is string => Boolean(k))
  // De-dup while preserving order.
  const seen = new Set<string>()
  const out = keys.filter(k => (seen.has(k) ? false : (seen.add(k), true)))
  process.stdout.write(out.join(' '))
}

main()
