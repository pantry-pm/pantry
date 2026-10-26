import type { NativeCommand } from './command'
import type { NativeAppConfig } from './config'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runNativeCommand, succeeded } from './command'

export function nativeRuntimeProfile(revision: string, minimumMacos: string, arch: string = process.arch): string {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Craft revision must be immutable')
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(minimumMacos)) throw new Error('A valid minimum macOS version is required')
  const architecture = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined
  if (!architecture) throw new Error(`Unsupported native architecture: ${arch}`)
  return `revision=${revision};ReleaseSmall;js-runtime=false;target=${architecture}-macos.${minimumMacos}`
}

export function nativeRuntimeCacheKey(config: NativeAppConfig, minimumMacos: string, arch: string = process.arch): string {
  if (!config.runtime) throw new Error('No Craft runtime configured')
  return createHash('sha256').update(`${nativeRuntimeProfile(config.runtime.revision, minimumMacos, arch)};version=${config.runtime.version};schema=1`).digest('hex')
}

export function lockedCraftCompilerVersion(lock: { workspaces?: Record<string, { system?: Record<string, unknown> }> }): string {
  const version = lock.workspaces?.['']?.system?.['ziglang.org']
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) throw new Error('Craft must lock an exact Zig compiler version')
  return version
}

export type CraftDependencyPlan = { kind: 'manifest' } | { kind: 'legacy-pins', sources: { repository: string, revision: string, directory: string }[] }

/** Follow the dependency contract committed by the pinned Craft revision. */
export function craftDependencyPlan(checkout: string): CraftDependencyPlan {
  if (!existsSync(join(checkout, 'packages/zig/build.zig.zon'))) throw new Error('Craft dependency manifest is missing')
  const pinsPath = join(checkout, '.github/actions/first-party-zig-deps/pins.env')
  if (!existsSync(pinsPath)) return { kind: 'manifest' }
  const pins = readFileSync(pinsPath, 'utf8')
  const sources = [['zig-js', 'zig_js'], ['zig-regex', 'zig_regex'], ['zig-gc', 'zig_gc']].map(([directory, key]) => {
    const revision = pins.match(new RegExp(`^${key}=([a-f0-9]{40})$`, 'm'))?.[1]
    if (!revision) throw new Error(`Missing upstream dependency pin: ${key}`)
    return { repository: `zig-utils/${directory}`, revision, directory: directory! }
  })
  return { kind: 'legacy-pins', sources }
}

/** Build source with upstream dependency pins and the compiler in its lockfile. */
export async function provisionNativeRuntime(root: string, config: NativeAppConfig, minimumMacos: string, options: { command?: NativeCommand, env?: NodeJS.ProcessEnv } = {}): Promise<string | undefined> {
  const env = options.env ?? process.env
  if (env.CRAFT_BIN) {
    const binary = resolve(root, env.CRAFT_BIN)
    if (!existsSync(binary)) throw new Error(`CRAFT_BIN does not exist: ${binary}`)
    return binary
  }
  if (!config.runtime) return undefined
  if (process.platform !== 'darwin') throw new Error('The configured macOS Craft runtime must be built on macOS')
  const command = options.command ?? runNativeCommand
  const { revision, version } = config.runtime
  const profile = nativeRuntimeProfile(revision, minimumMacos)
  const workspace = join(root, '.pantry/native/runtimes', nativeRuntimeCacheKey(config, minimumMacos))
  const checkout = join(workspace, 'Tools/craft')
  const binary = join(checkout, 'packages/zig/zig-out/bin/craft')
  const stamp = join(checkout, '.pantry-runtime-profile')
  const run = async (args: string[], cwd: string, runEnv = env, inherit = false) => succeeded(args[0]!, await command(args[0]!, args.slice(1), { cwd, env: runEnv, inherit }))
  const clone = async (repository: string, pin: string, destination: string) => {
    if (!/^[a-f0-9]{40}$/.test(pin)) throw new Error(`Missing immutable dependency pin: ${repository}`)
    mkdirSync(destination, { recursive: true })
    if (!existsSync(join(destination, '.git'))) {
      await run(['git', 'init', '--quiet'], destination)
      await run(['git', 'remote', 'add', 'origin', `https://github.com/${repository}.git`], destination)
      await run(['git', 'fetch', '--quiet', '--depth', '1', 'origin', pin], destination)
      await run(['git', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], destination)
    }
    const current = (await run(['git', 'rev-parse', 'HEAD'], destination)).stdout.trim()
    if (current !== pin) throw new Error(`Unexpected source revision in ${destination}: ${current}`)
    const dirty = (await run(['git', 'status', '--porcelain', '--untracked-files=no'], destination)).stdout.trim()
    if (dirty) throw new Error(`Modified runtime source in ${destination}`)
  }
  // Verify source identity even on a cache hit; a binary alone is not provenance.
  await clone('craft-native/craft', revision, checkout)
  const dependencies = craftDependencyPlan(checkout)
  if (dependencies.kind === 'legacy-pins') {
    for (const source of dependencies.sources)
      await clone(source.repository, source.revision, join(workspace, 'Libraries', source.directory))
  }
  if (!existsSync(binary) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== profile) {
    // A failed rebuild must never leave a previous success stamp usable.
    rmSync(stamp, { force: true })
    const lock = JSON.parse(readFileSync(join(checkout, 'pantry.lock'), 'utf8'))
    const zigVersion = lockedCraftCompilerVersion(lock)
    await run(['pantry', 'install', `ziglang.org@${zigVersion}`, '--no-save', '--ignore-scripts'], checkout, env, true)
    const zig = join(checkout, 'pantry/ziglang.org', `v${zigVersion}`, 'bin/zig')
    if (!existsSync(zig)) throw new Error(`Locked Zig compiler is missing: ${zig}`)
    const buildEnv = { ...env, CRAFT_ZIG: zig }
    // Current Craft declares immutable URLs and native hashes in its package
    // manifest. Use the locked compiler's normal resolver, as upstream CI does.
    if (dependencies.kind === 'manifest')
      await run(['bun', 'scripts/zig.ts', '--core', 'build', '--fetch'], checkout, buildEnv, true)
    const sdk = (await run(['xcrun', '--sdk', 'macosx', '--show-sdk-path'], checkout)).stdout.trim()
    if (!sdk) throw new Error('The macOS SDK is required')
    const target = profile.split('target=')[1]!
    await run(['bun', 'scripts/zig.ts', '--core', '--versioned', 'build', '-Doptimize=ReleaseSmall', '-Djs-runtime=false', `-Dtarget=${target}`, `-Dmacos-sdk=${sdk}`], checkout, buildEnv, true)
    writeFileSync(stamp, profile)
  }
  const found = await run([binary, '--version'], checkout)
  if (!`${found.stdout}${found.stderr}`.includes(`craft version ${version}`)) throw new Error(`Craft does not match configured version ${version}`)
  return binary
}
