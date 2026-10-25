import { versionBump } from '@stacksjs/bumpx'
import type { NativeCommand } from './command'
import { runNativeCommand, succeeded } from './command'
import { prepareNativeRelease } from './pipeline'

export type NativeReleaseBump = 'patch' | 'minor' | 'major'

/** Qualify the app, then use the shared publisher to commit/tag/push once. */
export async function releaseNativeApp(root: string, options: { bump: NativeReleaseBump, dryRun?: boolean }, dependencies: { command?: NativeCommand } = {}): Promise<void> {
  if (!['patch', 'minor', 'major'].includes(options.bump)) throw new Error('Native release bump must be patch, minor or major')
  const command = dependencies.command ?? runNativeCommand
  const git = async (args: string[]) => succeeded('Native release Git check', await command('git', args, { cwd: root })).stdout.trim()
  const source = await git(['rev-parse', 'HEAD'])
  if (await git(['branch', '--show-current']) !== 'main') throw new Error('Native releases must be cut from main')
  if (await git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Commit native app source before releasing')
  await prepareNativeRelease(root, 'check', { command })
  await versionBump({ cwd: root, release: options.bump, expectedSource: source, recursive: true, commit: !options.dryRun, tag: !options.dryRun, push: !options.dryRun, dryRun: options.dryRun, yes: true })
}
