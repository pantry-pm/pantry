import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runNativeCommand } from '../src/native/command'

test.skipIf(process.platform === 'win32')('a bounded native command reaps its TERM-ignoring child before rejecting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-native-timeout-'))
  try {
    const pid = join(root, 'pid')
    const command = join(root, 'command')
    // exec retains one owned process. Ignored TERM survives exec; KILL is
    // required, and no descendant can remain after the assertion.
    writeFileSync(command, '#!/bin/sh\ntrap "" TERM\nprintf "%s" "$$" > "$PID_FILE"\nexec /bin/sleep 1.5\n', { mode: 0o755 })
    await expect(runNativeCommand(command, [], { cwd: root, env: { ...process.env, PID_FILE: pid }, timeoutMs: 1000 })).rejects.toThrow('timed out')
    const ownedPid = Number(readFileSync(pid, 'utf8'))
    expect(Number.isSafeInteger(ownedPid)).toBe(true)
    expect(() => process.kill(ownedPid, 0)).toThrow()
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('native commands without a deadline retain input, both output streams and nonzero status', async () => {
  const result = await runNativeCommand(process.execPath, ['-e', 'let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",value=>input+=value);process.stdin.on("end",()=>{process.stdout.write(input);process.stderr.write("diagnostic");process.exitCode=7})'], { input: 'owned input' })
  expect(result).toEqual({ exitCode: 7, stdout: 'owned input', stderr: 'diagnostic' })
})

test('a failed native spawn clears its deadline so its caller can exit normally', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-native-spawn-'))
  try {
    const driver = join(root, 'driver.mjs')
    const entry = pathToFileURL(resolve(import.meta.dir, '../src/native/index.ts')).href
    writeFileSync(driver, `import {runNativeCommand} from ${JSON.stringify(entry)};try{await runNativeCommand(${JSON.stringify(join(root, 'not-installed'))},[],{timeoutMs:5000});throw new Error('Missing command unexpectedly ran')}catch(error){if(!String(error).includes('not-installed'))throw error;console.log('settled-missing')}`)
    const child = Bun.spawnSync([process.execPath, '--no-env-file', driver], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 3000 })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(child.stdout.toString().trim()).toBe('settled-missing')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform === 'win32')('a timed-out command with pending input settles without an unhandled pipe error', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-native-input-'))
  try {
    const driver = join(root, 'driver.mjs')
    const entry = pathToFileURL(resolve(import.meta.dir, '../src/native/index.ts')).href
    writeFileSync(driver, `import {runNativeCommand} from ${JSON.stringify(entry)};try{await runNativeCommand('/bin/sleep',['1.5'],{input:'x'.repeat(1048576),timeoutMs:100});throw new Error('Deadline unexpectedly succeeded')}catch(error){if(!String(error).includes('timed out'))throw error;console.log('settled-timeout')}`)
    const child = Bun.spawnSync([process.execPath, '--no-env-file', driver], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 3000 })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(child.stdout.toString().trim()).toBe('settled-timeout')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
  test(`an invalid native command deadline ${timeoutMs} refuses before spawning`, async () => {
    await expect(runNativeCommand('not-installed', [], { timeoutMs })).rejects.toThrow('positive integer')
  })
}
