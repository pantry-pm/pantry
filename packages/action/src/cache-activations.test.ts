import { expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preserveCommandActivations } from './cache-activations'

for (const fails of [false, true]) {
  test.skipIf(process.platform === 'win32')(`a ${fails ? 'partial failed' : 'successful'} cache extraction preserves previously selected commands`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry-activation-contract-'))
    try {
      const bin = join(root, '.bin')
      const selected = join(root, 'ziglang.org/v0.17.1')
      mkdirSync(selected, { recursive: true })
      mkdirSync(bin)
      writeFileSync(join(selected, 'zig'), '#!/bin/sh\nprintf "selected-compiler\\n"\n', { mode: 0o755 })
      symlinkSync('../ziglang.org/v0.17.1/zig', join(bin, 'zig'))
      const executor = '#!/bin/sh\nprintf "selected-executor:%s\\n" "$*"\n'
      writeFileSync(join(bin, 'bunx'), executor, { mode: 0o755 })
      const operation = preserveCommandActivations(bin, async () => {
        rmSync(join(bin, 'zig'))
        writeFileSync(join(bin, 'zig'), '#!/bin/sh\nprintf "stale-compiler\\n"\n', { mode: 0o755 })
        writeFileSync(join(bin, 'bunx'), 'stale executor')
        chmodSync(join(bin, 'bunx'), 0o600)
        writeFileSync(join(bin, 'new-tool'), 'cached new tool')
        if (fails) throw new Error('cache extraction interrupted')
        return 'exact-cache-key'
      })
      if (fails) await expect(operation).rejects.toThrow('cache extraction interrupted')
      else expect(await operation).toBe('exact-cache-key')
      expect(readlinkSync(join(bin, 'zig'))).toBe('../ziglang.org/v0.17.1/zig')
      expect(readFileSync(join(bin, 'bunx'), 'utf8')).toBe(executor)
      expect(lstatSync(join(bin, 'bunx')).mode & 0o777).toBe(0o755)
      const compiler = Bun.spawnSync([join(bin, 'zig'), 'version'])
      expect(compiler.exitCode).toBe(0)
      expect(compiler.stdout.toString().trim()).toBe('selected-compiler')
      const execute = Bun.spawnSync([join(bin, 'bunx'), '--bun', 'tool@1', '--version'])
      expect(execute.exitCode).toBe(0)
      expect(execute.stdout.toString().trim()).toBe('selected-executor:--bun tool@1 --version')
      expect(existsSync(join(bin, 'new-tool'))).toBe(true)
      // Requested package installation occurs after restoration and can select
      // a new version normally. Preservation does not freeze old selections.
      rmSync(join(bin, 'zig'))
      writeFileSync(join(bin, 'zig'), '#!/bin/sh\nprintf "new-explicit-compiler\\n"\n', { mode: 0o755 })
      expect(Bun.spawnSync([join(bin, 'zig'), 'version']).stdout.toString().trim()).toBe('new-explicit-compiler')
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('a fresh setup restores cache entries normally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-fresh-activation-'))
  try {
    const bin = join(root, '.bin')
    expect(await preserveCommandActivations(bin, async () => {
      mkdirSync(bin)
      writeFileSync(join(bin, 'bun'), 'new runtime')
      return 'fresh-cache'
    })).toBe('fresh-cache')
    expect(readFileSync(join(bin, 'bun'), 'utf8')).toBe('new runtime')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform === 'win32')('an unsafe activation directory fails before restoring cache bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-unsafe-activation-'))
  try {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(root, '.bin'))
    let restored = false
    await expect(preserveCommandActivations(join(root, '.bin'), async () => { restored = true })).rejects.toThrow('must be a real directory')
    expect(restored).toBe(false)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
