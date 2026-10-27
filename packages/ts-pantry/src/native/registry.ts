import { existsSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { publishBinaryArtifact } from '../binary-publish'
import type { PublishedBinaryArtifact } from '../binary-publish'
import { assessNativeMacArtifact, runStapler } from './apple'
import type { NativeCommand } from './command'
import { runNativeCommand, succeeded } from './command'
import { readNativeAppConfig, insideProject } from './config'
import { loadNativeEnvironment } from './environment'
import type { NativePipelineResult } from './pipeline'
import { prepareNativeRelease, validateNativeMacBundle } from './pipeline'

export interface NativeRegistryPublication {
  archive: string
  receipt: string
  publication: PublishedBinaryArtifact
}

interface RegistryDependencies {
  command?: NativeCommand
  env?: NodeJS.ProcessEnv
  publish?: typeof publishBinaryArtifact
}

async function registryCredential(root: string, url: string, env: NodeJS.ProcessEnv, command: NativeCommand): Promise<string> {
  const configured = env.PANTRY_REGISTRY_TOKEN || env.PANTRY_TOKEN
  if (configured) return configured
  // The CLI owns credential precedence and the private credentials-file format.
  const stored = succeeded('Read Pantry registry credential', await command('pantry', ['token', 'get', '--registry', url], { cwd: root, env })).stdout.trim()
  if (!stored) throw new Error('Configure a Pantry registry publishing token before releasing')
  return stored
}

/** Publish the already-qualified Developer ID app, never its Store-signed counterpart. */
export async function publishPreparedNativeRegistry(root: string, prepared: NativePipelineResult, dependencies: RegistryDependencies = {}): Promise<NativeRegistryPublication> {
  const config = readNativeAppConfig(root, true)!
  const target = config.registry
  if (!target) throw new Error('Configure native.registry in pantry.json before publishing to Pantry')
  const command = dependencies.command ?? runNativeCommand
  const env = dependencies.env ?? process.env
  const registryUrl = (target.url ?? 'https://registry.pantry.dev').replace(/\/+$/, '')
  const token = await registryCredential(root, registryUrl, env, command)
  const artifact = prepared.artifact
  if (!artifact?.appPath || artifact.target !== 'macos') throw new Error('Pantry native publication requires a qualified macOS app bundle')
  const app = insideProject(root, artifact.appPath)
  if (app.includes(`${join('.pantry', 'native', 'app-store')}/`)) throw new Error('A Store distribution bundle cannot be published as a standalone app')
  await validateNativeMacBundle(artifact, config.macos?.maxBundleSize, command)
  succeeded('Registry app signature', await command('codesign', ['--verify', '--deep', '--strict', app]))
  const identity = succeeded('Registry app identity', await command('codesign', ['-dv', '--verbose=4', app]))
  if (!`${identity.stdout}${identity.stderr}`.includes('Authority=Developer ID Application:')) throw new Error('Pantry app publication requires a Developer ID signature')
  await assessNativeMacArtifact(app, command)
  // DMG tickets do not travel with a tarball. Staple the app itself before archiving it.
  await runStapler('staple', app, command)
  await runStapler('validate', app, command)
  const architectures = succeeded('Read app architectures', await command('lipo', ['-archs', join(app, 'Contents/MacOS', artifact.name)])).stdout.trim().split(/\s+/)
  const platforms = [...new Set(architectures.map(arch => arch === 'arm64' ? 'darwin-arm64' : arch === 'x86_64' ? 'darwin-x86-64' : ''))]
  if (!platforms.length || platforms.includes('')) throw new Error('Unsupported native registry architecture')
  const slug = artifact.name.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').slice(0, 70)
  const filename = `${slug}-${prepared.version}-${artifact.buildNumber}-${platforms.join("_")}.tar.gz`
  const archive = insideProject(root, join('dist', filename))
  if (existsSync(archive)) throw new Error('Refusing to overwrite an existing native registry archive')
  succeeded('Archive notarized app', await command('tar', ['-czf', archive, '-C', dirname(app), basename(app)], { cwd: root, env }))
  const publication = await (dependencies.publish ?? publishBinaryArtifact)({
    domain: target.domain, version: prepared.version, platforms, filePath: archive,
    filename, size: statSync(archive).size, registryUrl, token,
  })
  const revision = env.GITHUB_SHA || succeeded('Read release source', await command('git', ['rev-parse', 'HEAD'], { cwd: root, env })).stdout.trim()
  const receipt = insideProject(root, join('dist', `${slug}-${prepared.version}-${artifact.buildNumber}-pantry.json`))
  writeFileSync(receipt, `${JSON.stringify({ schemaVersion: 1, registryUrl, bundleId: artifact.bundleId, buildNumber: artifact.buildNumber, sourceRevision: revision, ...publication }, null, 2)}\n`)
  return { archive, receipt, publication }
}

/** Buddy and CI use the same qualification and registry delivery implementation. */
export async function publishNativeRegistry(root: string, options: { buildNumber?: string } = {}, dependencies: RegistryDependencies = {}): Promise<NativeRegistryPublication> {
  if (options.buildNumber !== undefined && !/^[1-9]\d*$/.test(options.buildNumber)) throw new Error('Native registry build number must be a positive integer')
  const config = readNativeAppConfig(root, true)!
  if (!config.registry) throw new Error('Configure native.registry in pantry.json before publishing to Pantry')
  const env = { ...process.env, ...dependencies.env, ...loadNativeEnvironment(root, config.environment ?? 'production') }
  if (options.buildNumber) env.PANTRY_BUILD_NUMBER = options.buildNumber
  env.PANTRY_TOKEN = await registryCredential(root, config.registry.url ?? 'https://registry.pantry.dev', env, dependencies.command ?? runNativeCommand)
  const prepared = await prepareNativeRelease(root, 'release', { command: dependencies.command, env })
  return await publishPreparedNativeRegistry(root, prepared, { ...dependencies, env })
}
