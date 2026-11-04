import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { version as sdkVersion } from '../package.json'
import { nativePantryCliRange, nativeRuntimeCacheKey, nativeRuntimeProfile, resolveLockedZig, type NativeAppConfig } from '../src/native'

// Real Git/OS commands exercise the public SDK, with no injected NativeCommand.
// The authored local source is only an acquisition fixture. Every attempted
// install refuses with93, so no compiler acquisition or native build can occur.
async function fixture(run: (f: Awaited<ReturnType<typeof prepare>>) => Promise<void>, cold = false, checkoutVersion?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pantry-native-toolchain-')))
  try { await run(await prepare(root, cold, checkoutVersion)) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

function prepare(root: string, cold: boolean, checkoutVersion?: string) {
  const seed = join(root, 'source')
  const calls = join(root, 'calls')
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(root, 'bin')}:/usr/bin:/bin`, CALLS: calls, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' }
  delete env.CRAFT_BIN
  const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const pantry = (file: string, version: string, label: string, status = 0, output?: string) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${label}|'"$*" >> "$CALLS"\nif [ "$1" = --version ]; then printf '%s\\n' '${output ?? `pantry ${version} (fixture)`}'; exit ${status}; fi\nprintf 'guarded native install reached\\n' >&2\nexit 93\n`, { mode: 0o755 })
  }
  mkdirSync(join(seed, 'packages/zig'), { recursive: true })
  writeFileSync(join(seed, 'packages/zig/build.zig.zon'), '// Authored public API fixture; no native build is attempted.\n')
  writeFileSync(join(seed, 'pantry.lock'), JSON.stringify({ workspaces: { '': { system: { 'ziglang.org': '0.17.0' } } } }))
  if (checkoutVersion) pantry(join(seed, 'bin/pantry'), checkoutVersion, 'checkout')
  git(['init', '--quiet'], seed)
  git(['add', '.'], seed)
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'test: local native acquisition fixture'], seed)
  const revision = git(['rev-parse', 'HEAD'], seed)
  const config = { runtime: { revision, version: '0.0.424' } }
  const checkout = join(root, '.pantry/native/runtimes', nativeRuntimeCacheKey(config, '14.0'), 'Tools/craft')
  if (!cold) {
    mkdirSync(dirname(checkout), { recursive: true })
    git(['clone', '--quiet', '--no-hardlinks', seed, checkout])
  }
  const stamp = join(checkout, '.pantry-runtime-profile')
  if (!cold) writeFileSync(stamp, 'stale profile must survive a toolchain refusal\n')
  pantry(join(root, 'good-pantry'), sdkVersion, 'unrelated')
  env.PANTRY_BIN = join(root, 'good-pantry')
  // Real Git's local transport keeps cold acquisition offline while preserving
  // the public SDK's immutable revision/source verification.
  env.GIT_CONFIG_COUNT = '1'
  env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(seed).href}.insteadOf`
  env.GIT_CONFIG_VALUE_0 = 'https://github.com/craft-native/craft.git'
  const driver = join(root, 'driver.mjs')
  writeFileSync(driver, `import {provisionNativeRuntime} from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src/native/index.ts')).href)};
const options=process.env.OPTIONS_ENV?{env:JSON.parse(process.env.OPTIONS_ENV)}:{};
const config=process.env.CONFIG_JSON?JSON.parse(process.env.CONFIG_JSON):${JSON.stringify(config)};
try {
  const binary=await provisionNativeRuntime(process.cwd(),config,'14.0',options);
  console.log(JSON.stringify({binary}));
}
catch(error) {
  console.error(String(error));
  process.exitCode=1;
}`)
  const invoke = (optionsEnv?: NodeJS.ProcessEnv, configOverride?: NativeAppConfig) => {
    const child = Bun.spawnSync([process.execPath, '--no-env-file', driver], { cwd: root, env: { ...env, ...(optionsEnv ? { OPTIONS_ENV: JSON.stringify(optionsEnv) } : {}), ...(configOverride ? { CONFIG_JSON: JSON.stringify(configOverride) } : {}) }, stdout: 'pipe', stderr: 'pipe', timeout: 12_000 })
    return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
  }
  const recorded = () => existsSync(calls) ? readFileSync(calls, 'utf8') : ''
  const qualifyCache = (version = config.runtime.version) => {
    const binary = join(checkout, 'packages/zig/zig-out/bin/craft')
    mkdirSync(dirname(binary), { recursive: true })
    writeFileSync(binary, `#!/bin/sh\nprintf 'craft version ${version}\\n'\n`, { mode: 0o755 })
    writeFileSync(stamp, nativeRuntimeProfile(revision, '14.0'))
    return binary
  }
  return { root, seed, env, config, checkout, stamp, pantry, invoke, recorded, qualifyCache, git }
}

function cacheTree(root: string): unknown[] {
  if (!existsSync(root)) return []
  return readdirSync(root).sort().map(name => {
    const file = join(root, name)
    const stat = lstatSync(file)
    return [name, stat.mode, stat.isSymbolicLink() ? readlinkSync(file) : stat.isDirectory() ? cacheTree(file) : createHash('sha256').update(readFileSync(file)).digest('hex')]
  })
}

for (const version of ['0.11.156', '0.11.142']) {
  test.skipIf(process.platform !== 'darwin')(`public native provisioning refuses bare Pantry ${version} before install or profile invalidation`, async () => {
    await fixture(async f => {
      f.pantry(join(f.root, 'bin/pantry'), version, 'bare')
      const before = cacheTree(join(f.root, '.pantry'))
      const result = f.invoke()
      expect(result.code).not.toBe(0)
      expect(f.recorded()).toBe('bare|--version\n')
      expect(cacheTree(join(f.root, '.pantry'))).toEqual(before)
      expect(result.stderr).toContain('Pantry')
    })
  })
}

test.skipIf(process.platform !== 'darwin')('the paired native CLI cohort reaches the real guarded installer after both cwd checks', async () => {
  await fixture(async f => {
    f.pantry(join(f.root, 'bin/pantry'), sdkVersion, 'bare')
    const result = f.invoke()
    expect(nativePantryCliRange).toBe(`^${sdkVersion}`)
    expect(result.code).not.toBe(0)
    expect(f.recorded()).toBe('bare|--version\nbare|--version\nbare|install ziglang.org@0.17.0 --no-save --ignore-scripts\n')
    expect(result.stderr).toContain('guarded native install reached')
    expect(existsSync(f.stamp)).toBe(false)
  })
})

for (const state of ['broken', 'malformed', 'wrong-brand', 'leading-zero', 'junk-suffix', 'interpreter', 'missing']) {
  test.skipIf(process.platform !== 'darwin')(`a ${state} native CLI refuses before existing cache mutation`, async () => {
    await fixture(async f => {
      const binary = join(f.root, 'bin/pantry')
      const output = state === 'malformed' ? 'pantry not-a-version' : state === 'wrong-brand' ? `ts-pantry/${sdkVersion}` : state === 'leading-zero' ? `pantry 0${sdkVersion}` : state === 'junk-suffix' ? `pantry ${sdkVersion}/junk` : undefined
      f.pantry(binary, sdkVersion, 'bare', state === 'broken' ? 42 : 0, output)
      if (state === 'interpreter') writeFileSync(binary, '#!/no-such-pantry-interpreter\n', { mode: 0o755 })
      if (state === 'missing') rmSync(binary)
      const before = cacheTree(join(f.root, '.pantry'))
      const result = f.invoke()
      expect(result.code).not.toBe(0)
      expect(f.recorded()).not.toContain('|install')
      expect(cacheTree(join(f.root, '.pantry'))).toEqual(before)
      expect(result.stderr).toContain(nativePantryCliRange)
    })
  })
}

const [sdkMajor, sdkMinor, sdkPatch] = sdkVersion.split(/[+-]/)[0]!.split('.').map(Number)
for (const version of [`${sdkMajor! + 1}.0.0`, `${sdkMajor}.${sdkMinor}.${sdkPatch! + 1}-dev.1`]) {
  test.skipIf(process.platform !== 'darwin')(`a recognized CLI version ${version} outside the paired caret range refuses without mutation`, async () => {
    await fixture(async f => {
      f.pantry(join(f.root, 'bin/pantry'), version, 'bare')
      const before = cacheTree(join(f.root, '.pantry'))
      const result = f.invoke()
      expect(result.code).not.toBe(0)
      expect(f.recorded()).toBe('bare|--version\n')
      expect(result.stderr).toContain(`Found ${version}`)
      expect(cacheTree(join(f.root, '.pantry'))).toEqual(before)
    })
  })
}

test.skipIf(process.platform !== 'darwin')('valid CLI build metadata preserves compatibility with its paired cohort', async () => {
  await fixture(async f => {
    f.pantry(join(f.root, 'bin/pantry'), `${sdkVersion.split('+')[0]}+fixture`, 'bare')
    const result = f.invoke()
    expect(result.code).not.toBe(0)
    expect(f.recorded()).toContain('bare|install ziglang.org@0.17.0 --no-save --ignore-scripts\n')
    expect(result.stderr).toContain('guarded native install reached')
  })
})

test.skipIf(process.platform !== 'darwin')('an existing checkout checks its relative PATH before any cache write', async () => {
  await fixture(async f => {
    f.pantry(join(f.root, 'bin/pantry'), sdkVersion, 'entry')
    f.env.PATH = 'bin:/usr/bin:/bin'
    const before = cacheTree(join(f.root, '.pantry'))
    const result = f.invoke()
    expect(result.code).not.toBe(0)
    expect(f.recorded()).toBe('checkout|--version\n')
    expect(cacheTree(join(f.root, '.pantry'))).toEqual(before)
  }, false, '0.11.156')
})

test.skipIf(process.platform !== 'darwin')('a complete options environment selects the actual command instead of the process PATH', async () => {
  await fixture(async f => {
    f.pantry(join(f.root, 'bin/pantry'), sdkVersion, 'process')
    f.pantry(join(f.root, 'selected/pantry'), '0.11.156', 'selected')
    const before = cacheTree(join(f.root, '.pantry'))
    const result = f.invoke({ ...f.env, PATH: `${join(f.root, 'selected')}:/usr/bin:/bin` })
    expect(result.code).not.toBe(0)
    expect(f.recorded()).toBe('selected|--version\n')
    expect(cacheTree(join(f.root, '.pantry'))).toEqual(before)
  })
})

test.skipIf(process.platform !== 'darwin')('an empty options environment does not borrow the compatible process PATH', async () => {
  await fixture(async f => {
    f.pantry(join(f.root, 'bin/pantry'), sdkVersion, 'process')
    const before = cacheTree(join(f.root, '.pantry'))
    const result = f.invoke({})
    expect(result.code).not.toBe(0)
    expect(f.recorded()).toBe('')
    expect(result.stderr).toContain('Could not run `pantry --version`')
    expect(cacheTree(join(f.root, '.pantry'))).toEqual(before)
  })
})

test.skipIf(process.platform !== 'darwin')('a cold checkout refuses its incompatible entry CLI before acquisition', async () => {
  await fixture(async f => {
    f.pantry(join(f.root, 'bin/pantry'), '0.11.156', 'entry')
    const result = f.invoke()
    expect(result.code).not.toBe(0)
    expect(f.recorded()).toBe('entry|--version\n')
    expect(existsSync(join(f.root, '.pantry'))).toBe(false)
  }, true)
})

test.skipIf(process.platform !== 'darwin')('cold acquisition revalidates the actual checkout cwd and leaves only unqualified immutable source on refusal', async () => {
  await fixture(async f => {
    f.pantry(join(f.root, 'bin/pantry'), sdkVersion, 'entry')
    f.env.PATH = 'bin:/usr/bin:/bin'
    const result = f.invoke()
    expect(result.code, result.stderr).not.toBe(0)
    expect(f.recorded()).toBe('entry|--version\ncheckout|--version\n')
    expect(f.git(['rev-parse', 'HEAD'], f.checkout)).toBe(f.config.runtime.revision)
    expect(f.git(['status', '--porcelain', '--untracked-files=no'], f.checkout)).toBe('')
    expect(existsSync(f.stamp)).toBe(false)
    expect(existsSync(join(f.checkout, 'packages/zig/zig-out/bin/craft'))).toBe(false)
  }, true, '0.11.156')
})

test.skipIf(process.platform !== 'darwin')('a qualified cached runtime retains provenance checks without requiring unused Pantry', async () => {
  await fixture(async f => {
    const binary = f.qualifyCache()
    const result = f.invoke()
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).binary).toBe(binary)
    expect(f.recorded()).toBe('')
    expect(readFileSync(f.stamp, 'utf8')).toBe(nativeRuntimeProfile(f.config.runtime.revision, '14.0'))
  })
})

for (const invalid of ['source', 'binary']) {
  test.skipIf(process.platform !== 'darwin')(`a cached runtime with invalid ${invalid} remains rejected without probing Pantry`, async () => {
    await fixture(async f => {
      f.qualifyCache(invalid === 'binary' ? '0.0.1' : undefined)
      if (invalid === 'source') writeFileSync(join(f.checkout, 'packages/zig/build.zig.zon'), '// changed tracked source\n')
      const result = f.invoke()
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain(invalid === 'source' ? 'Modified runtime source' : 'Craft does not match configured version')
      expect(f.recorded()).toBe('')
    })
  })
}

test('explicit CRAFT_BIN and an absent runtime do not probe or require Pantry', async () => {
  await fixture(async f => {
    const binary = join(f.root, 'explicit-craft')
    writeFileSync(binary, '#!/bin/sh\nprintf "craft version 0.0.424\\n"\n', { mode: 0o755 })
    const before = cacheTree(join(f.root, '.pantry'))
    const explicit = f.invoke({ CRAFT_BIN: binary })
    expect(explicit.code, explicit.stderr).toBe(0)
    expect(JSON.parse(explicit.stdout).binary).toBe(binary)
    const absent = f.invoke(undefined, {})
    expect(absent.code, absent.stderr).toBe(0)
    expect(JSON.parse(absent.stdout)).toEqual({})
    expect(f.recorded()).toBe('')
    expect(cacheTree(join(f.root, '.pantry'))).toEqual(before)
  })
})

test('the locked Zig compiler is found whichever layout the installer unpacked', () => {
  const root = join('/pkg', 'ziglang.org', 'v0.18.0-dev.146+35accc06e')
  const underBin = join(root, 'bin', 'zig')
  const atRoot = join(root, 'zig')
  // A package that ships a bin directory, which is what earlier releases unpacked to.
  expect(resolveLockedZig(root, path => path === underBin)).toBe(underBin)
  // Zig's own archive, which carries the compiler at the root beside lib, doc and the licence.
  expect(resolveLockedZig(root, path => path === atRoot)).toBe(atRoot)
  // bin wins when both are present, so a package that gained one does not change which binary is used.
  expect(resolveLockedZig(root, () => true)).toBe(underBin)
  expect(resolveLockedZig(root, () => false)).toBeNull()
})
