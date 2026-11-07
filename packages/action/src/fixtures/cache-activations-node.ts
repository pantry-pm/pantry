import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preserveCommandActivations } from '../cache-activations'

async function verify(): Promise<void> {
  for (const interrupted of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'pantry-node-cache-contract-'))
    try {
      const bin = join(root, '.bin')
      mkdirSync(join(root, 'compiler'), { recursive: true })
      mkdirSync(bin)
      writeFileSync(join(root, 'compiler/zig'), '#!/bin/sh\nprintf "selected-compiler\\n"\n', { mode: 0o755 })
      symlinkSync('../compiler/zig', join(bin, 'zig'))
      const launcher = '#!/bin/sh\nprintf "selected-executor:%s\\n" "$*"\n'
      writeFileSync(join(bin, 'bunx'), launcher, { mode: 0o755 })
      const operation = preserveCommandActivations(bin, async () => {
        rmSync(join(bin, 'zig'))
        writeFileSync(join(bin, 'zig'), 'stale compiler')
        writeFileSync(join(bin, 'bunx'), 'stale launcher', { mode: 0o600 })
        if (interrupted) throw new Error('interrupted cache extraction')
        return 'cache-hit'
      })
      if (interrupted) await assert.rejects(operation, /interrupted cache extraction/)
      else assert.equal(await operation, 'cache-hit')
      assert.equal(readlinkSync(join(bin, 'zig')), '../compiler/zig')
      assert.equal(execFileSync(join(bin, 'zig'), ['version'], { encoding: 'utf8', timeout: 4000 }).trim(), 'selected-compiler')
      assert.equal(readFileSync(join(bin, 'bunx'), 'utf8'), launcher)
      assert.equal(lstatSync(join(bin, 'bunx')).mode & 0o777, 0o755)
      assert.equal(execFileSync(join(bin, 'bunx'), ['--bun', 'tool@1'], { encoding: 'utf8', timeout: 4000 }).trim(), 'selected-executor:--bun tool@1')
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  }
}
verify().catch((error) => { console.error(error); process.exitCode = 1 })
