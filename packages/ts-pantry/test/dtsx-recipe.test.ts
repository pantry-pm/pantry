import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateBuildScript } from '../scripts/buildkit'
import { loadRecipe } from '../scripts/recipe-loader'

// Component tests start with downloaded bytes. Public release/download and
// native registry qualification remain separate integration boundaries.
for (const variant of ['valid', 'fresh prefix', 'wrong digest', 'missing entry', 'duplicate entry', 'malformed digest', 'nonhex digest', 'extra fields', 'invalid zip']) {
  test(`dtsx recipe verifies and installs only its requested payload: ${variant}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pantry-dtsx-recipe-'))
    try {
      const prefix = join(root, 'install')
      const binary = join(prefix, 'bin/zig-dtsx')
      if (variant !== 'fresh prefix') {
        await mkdir(join(prefix, 'bin'), { recursive: true })
        await writeFile(binary, 'previous usable binary', { mode: 0o755 })
      }
      const { recipe } = await loadRecipe('zig-dtsx.stacksjs.org', 'darwin-arm64', '1.0.0')
      const steps = recipe.build?.script
      expect(Array.isArray(steps)).toBe(true)
      if (!Array.isArray(steps)) throw new Error('The recipe must have explicit build stages')
      const start = steps.findIndex(step => typeof step === 'string' && step.startsWith('awk -v name='))
      expect(start).toBeGreaterThanOrEqual(0)
      const component = { ...recipe, build: { ...recipe.build, script: steps.slice(start) } }
      const script = generateBuildScript(component, 'zig-dtsx.stacksjs.org', '1.0.0', 'darwin-arm64', prefix, root, {})
      const scriptPath = join(root, '_build.sh')
      await writeFile(scriptPath, script)
      const asset = 'zig-dtsx-darwin-arm64.zip'
      const archive = variant === 'invalid zip' ? Buffer.from('invalid archive bytes')
        : await readFile(new URL('./fixtures/zig-dtsx-recipe.zip', import.meta.url))
      await writeFile(join(root, asset), archive)
      const digest = createHash('sha256').update(archive).digest('hex')
      const line = `${digest}  ${asset}\n`
      const checksums = variant === 'wrong digest' ? `${'0'.repeat(64)}  ${asset}\n`
        : variant === 'missing entry' ? `${digest}  another-platform.zip\n`
        : variant === 'duplicate entry' ? line + line
        : variant === 'malformed digest' ? `invalid  ${asset}\n`
        : variant === 'nonhex digest' ? `${'0'.repeat(63)}g  ${asset}\n`
        : variant === 'extra fields' ? `${digest}  ${asset} unexpected\n` : line
      await writeFile(join(root, 'checksums.txt'), checksums)
      if (variant === 'fresh prefix') expect(existsSync(prefix)).toBe(false)
      const result = Bun.spawnSync(['bash', '-euo', 'pipefail', scriptPath], {
        cwd: root, env: { ...process.env, ASSET: asset, prefix, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH}` }, timeout: 4000,
      })
      if (variant === 'valid' || variant === 'fresh prefix') {
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        expect(await readFile(binary, 'utf8')).toBe("#!/bin/sh\nprintf 'recipe fixture\\n'\n")
        expect((await stat(binary)).mode & 0o777).toBe(0o755)
        expect(await readdir(join(prefix, 'bin'))).toEqual(['zig-dtsx'])
        expect(await readdir(root)).not.toContain('unrelated.txt')
      }
      else {
        expect(result.exitCode).not.toBe(0)
        expect(await readFile(binary, 'utf8')).toBe('previous usable binary')
      }
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })
}
