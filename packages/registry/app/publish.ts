/**
 * Legacy Pantry publish helper.
 *
 * This intentionally publishes through the registry HTTP API. Direct S3 or
 * DynamoDB writes bypass authentication, ownership checks, immutable-version
 * checks, and publish-time malware scanning, so they are not a supported
 * publication path.
 */

import { execSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'

interface PackageJson {
  name: string
  version: string
  description?: string
  author?: string | { name: string, email?: string }
  license?: string
  keywords?: string[]
  repository?: string | { type: string, url: string }
  homepage?: string
  bin?: string | Record<string, string>
  contentPolicy?: unknown
}

function getGitRemoteUrl(targetDir: string): string | undefined {
  try {
    const value = execSync('git remote get-url origin', {
      cwd: targetDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (value.startsWith('git@')) {
      const match = value.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
      return match ? `https://${match[1]}/${match[2]}` : value
    }
    return value.replace(/\.git$/, '')
  }
  catch {
    return undefined
  }
}

function runPack(targetDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const packScript = join(import.meta.dir, 'pack.ts')
    const child = spawn('bun', ['run', packScript, targetDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', data => stdout += data.toString())
    child.stderr?.on('data', data => stderr += data.toString())
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `pack exited ${code}`))
      const match = stdout.match(/📦\s+(\S+\.tgz)/)
      if (!match) return reject(new Error('pack did not report a tarball path'))
      resolve(join(targetDir, match[1]))
    })
  })
}

export async function publish(targetDir: string = process.cwd()): Promise<void> {
  const packageJsonPath = join(targetDir, 'package.json')
  if (!existsSync(packageJsonPath)) throw new Error(`No package.json found in ${targetDir}`)

  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson
  if (!manifest.name) throw new Error('package.json is missing "name"')
  if (!manifest.version) throw new Error('package.json is missing "version"')

  const token = process.env.PANTRY_REGISTRY_TOKEN || process.env.PANTRY_TOKEN
  if (!token) throw new Error('PANTRY_REGISTRY_TOKEN or PANTRY_TOKEN is required')
  const registryUrl = (process.env.PANTRY_REGISTRY_URL || process.env.BASE_URL || 'https://registry.pantry.dev').replace(/\/+$/, '')

  console.log(`Publishing ${manifest.name}@${manifest.version} through ${registryUrl}`)
  const tarballPath = await runPack(targetDir)
  try {
    const tarball = readFileSync(tarballPath)
    const repository = typeof manifest.repository === 'string'
      ? manifest.repository
      : manifest.repository?.url || getGitRemoteUrl(targetDir)
    const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name

    const form = new FormData()
    form.set('metadata', JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author,
      license: manifest.license,
      keywords: manifest.keywords,
      repository,
      homepage: manifest.homepage,
      bin: manifest.bin,
      contentPolicy: manifest.contentPolicy,
      publishedAt: new Date().toISOString(),
    }))
    form.set('tarball', new File([tarball], basename(tarballPath), { type: 'application/gzip' }))

    const response = await fetch(`${registryUrl}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    const result = await response.json().catch(() => ({ error: response.statusText })) as any
    if (!response.ok) {
      const retry = result.retryable ? ' (retryable)' : ''
      throw new Error(`${result.code || response.status}: ${result.error || response.statusText}${retry}`)
    }

    const sizeKB = (statSync(tarballPath).size / 1024).toFixed(2)
    console.log(`Published ${manifest.name}@${manifest.version} (${sizeKB} KB)`)
    console.log(`Malware scan: ${result.scan?.verdict || 'unknown'} via ${result.scan?.engine || 'unknown'}`)
  }
  finally {
    try { unlinkSync(tarballPath) }
    catch { /* best-effort cleanup */ }
  }
}

if (import.meta.main) {
  publish(process.argv[2] || process.cwd()).catch((error) => {
    console.error(`Failed to publish: ${(error as Error).message}`)
    process.exit(1)
  })
}
