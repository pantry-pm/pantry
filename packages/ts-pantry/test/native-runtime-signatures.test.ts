import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixUp } from '../scripts/fix-up'

// Catches signature/entitlement loss through publication normalization. This
// uses local ad-hoc signing, not Developer ID credentials or notarization.
test.skipIf(process.platform !== 'darwin')('publication preserves an unchanged valid signature and is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-signed-runtime-'))
  const stage = join(root, 'artifact')
  const program = join(stage, 'bin', 'fixture')
  const run = (args: string[]): void => {
    const result = Bun.spawnSync(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  }
  try {
    mkdirSync(join(stage, 'bin'), { recursive: true })
    writeFileSync(join(root, 'main.c'), 'int main(void) { return 0; }')
    writeFileSync(join(root, 'entitlements.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>')
    run(['xcrun', 'clang', join(root, 'main.c'), '-o', program])
    run(['codesign', '--force', '--sign', '-', '--identifier', 'org.pantry.fixture.signed-runtime', '--options', 'runtime', '--entitlements', join(root, 'entitlements.plist'), program])
    run(['codesign', '--verify', '--strict', program])
    chmodSync(program, 0o555)
    const original = readFileSync(program)

    await fixUp(stage, 'darwin-arm64')
    expect(readFileSync(program).equals(original)).toBe(true)
    expect(statSync(program).mode & 0o777).toBe(0o555)
    run(['codesign', '--verify', '--strict', program])

    await fixUp(stage, 'darwin-arm64')
    expect(readFileSync(program).equals(original)).toBe(true)
    run(['codesign', '--verify', '--strict', program])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
}, 30_000)

test.skipIf(process.platform !== 'darwin')('publication still signs an unsigned native image', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-unsigned-runtime-'))
  const stage = join(root, 'artifact')
  const program = join(stage, 'bin', 'fixture')
  const run = (args: string[]): void => {
    const result = Bun.spawnSync(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  }
  try {
    mkdirSync(join(stage, 'bin'), { recursive: true })
    writeFileSync(join(root, 'main.c'), 'int main(void) { return 0; }')
    run(['xcrun', 'clang', join(root, 'main.c'), '-o', program])
    run(['codesign', '--remove-signature', program])
    expect(Bun.spawnSync(['codesign', '--verify', '--strict', program], { stderr: 'pipe' }).exitCode).not.toBe(0)

    await fixUp(stage, 'darwin-arm64')
    run(['codesign', '--verify', '--strict', program])
    const signed = readFileSync(program)
    await fixUp(stage, 'darwin-arm64')
    expect(readFileSync(program).equals(signed)).toBe(true)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
}, 30_000)
