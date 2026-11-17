import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { machoEntitlements, normalizeMachoRuntime, resignPreservingEntitlements } from '../scripts/native-runtime'

const darwin = process.platform === 'darwin'

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.virtualization</key>
  <true/>
  <key>com.apple.security.hypervisor</key>
  <true/>
</dict>
</plist>
`

/** A tiny Mach-O executable signed with the given entitlements (as lima's and qemu's builds do). */
function entitledBinary(root: string): string {
  const bin = join(root, 'prefix/bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(root, 'main.c'), 'int main(void) { return 0; }\n')
  const exe = join(bin, 'limactl')
  execFileSync('cc', ['-o', exe, join(root, 'main.c')])
  writeFileSync(join(root, 'vz.entitlements'), plist)
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', join(root, 'vz.entitlements'), exe])
  return exe
}

test.skipIf(!darwin)('re-signing after a loader-path edit keeps the entitlements', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-entitlements-test-'))
  try {
    const exe = entitledBinary(root)
    expect(machoEntitlements(exe)).toContain('com.apple.security.virtualization')
    // A lib directory makes the normalizer add an rpath, which invalidates the
    // signature and forces a re-sign: the path that used to drop entitlements.
    mkdirSync(join(root, 'prefix/lib'))
    normalizeMachoRuntime(join(root, 'prefix'), file => file === exe)
    const after = machoEntitlements(exe)
    expect(after).toContain('com.apple.security.virtualization')
    expect(after).toContain('com.apple.security.hypervisor')
    execFileSync('codesign', ['--verify', '--strict', exe])
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!darwin)('unsigned and entitlement-free binaries are still ad-hoc signed', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-entitlements-test-'))
  try {
    writeFileSync(join(root, 'main.c'), 'int main(void) { return 0; }\n')
    const exe = join(root, 'plain')
    execFileSync('cc', ['-o', exe, join(root, 'main.c')])
    execFileSync('codesign', ['--remove-signature', exe])
    expect(machoEntitlements(exe)).toBeNull()
    resignPreservingEntitlements(exe)
    execFileSync('codesign', ['--verify', '--strict', exe])
    expect(machoEntitlements(exe)).toBeNull()
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})
