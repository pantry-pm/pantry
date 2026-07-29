#!/usr/bin/env bun

/**
 * Publish package binaries through the Pantry registry.
 *
 * The historical filename is retained because build and sync workflows import
 * it. It no longer owns object-storage credentials or writes installable keys:
 * every artifact goes through the registry's scan-before-promote API.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { publishBinaryArtifact } from './binary-publish-client'

export interface UploadOptions {
  package: string
  version: string
  artifactsDir: string
  /** Retained for CLI/backward compatibility; storage is registry-owned. */
  bucket?: string
  /** Retained for CLI/backward compatibility; storage is registry-owned. */
  region?: string
  platforms?: string[]
  registryUrl?: string
  token?: string
}

function canonical(value: string): string {
  return value.replace(/[/.]/g, '-')
}

export async function uploadToS3(options: UploadOptions): Promise<void> {
  const pkgName = options.package
  const platformOverride = options.platforms?.length ? [...new Set(options.platforms)] : null
  if (!existsSync(options.artifactsDir))
    throw new Error(`Artifacts directory not found: ${options.artifactsDir}`)

  const artifactDirs = readdirSync(options.artifactsDir)
    .filter(name => statSync(join(options.artifactsDir, name)).isDirectory())
  if (artifactDirs.length === 0)
    throw new Error('No artifact directories found')

  console.log(`\nPublishing ${pkgName}@${options.version} through the Pantry registry`)
  let published = 0
  for (const artifactDir of artifactDirs) {
    const artifactPath = join(options.artifactsDir, artifactDir)
    const files = readdirSync(artifactPath)
    const tarball = files.find(file => file.endsWith('.tar.gz'))
    if (!tarball) continue

    const expectedPrefix = `${canonical(`${pkgName}-${options.version}`)}-`
    if (!canonical(tarball).startsWith(expectedPrefix)) {
      console.log(`   Skipping stale artifact ${tarball}`)
      continue
    }

    const platformMatch = artifactDir.match(/-(darwin|linux|windows|freebsd)-(arm64|x86-64|x86|riscv64)$/)
    if (!platformMatch && !platformOverride) {
      console.log(`   Skipping ${artifactDir}: platform could not be determined`)
      continue
    }
    const platforms = platformOverride || [`${platformMatch![1]}-${platformMatch![2]}`]
    const filePath = join(artifactPath, tarball)
    const size = statSync(filePath).size

    console.log(`   Staging ${tarball} (${(size / 1024 / 1024).toFixed(2)} MB) for ${platforms.join(', ')}`)
    const result = await publishBinaryArtifact({
      domain: pkgName,
      version: options.version,
      platforms,
      filePath,
      filename: tarball,
      size,
      registryUrl: options.registryUrl,
      token: options.token,
    })
    console.log(`   Clean: ${result.scan.artifactSha256} via ${result.scan.engine}`)
    published += platforms.length
  }

  if (published === 0)
    throw new Error(`No matching artifacts found for ${pkgName}@${options.version}`)
  console.log(`Published ${pkgName}@${options.version} for ${published} platform entry/entries`)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      package: { type: 'string', short: 'p' },
      version: { type: 'string', short: 'v' },
      'artifacts-dir': { type: 'string' },
      bucket: { type: 'string', short: 'b' },
      region: { type: 'string', short: 'r' },
      platforms: { type: 'string' },
      registry: { type: 'string' },
    },
    strict: true,
  })
  if (!values.package || !values.version || !values['artifacts-dir']) {
    console.error('Usage: upload-to-s3.ts --package <domain> --version <version> --artifacts-dir <dir> [--platforms <csv>] [--registry <url>]')
    process.exit(1)
  }
  await uploadToS3({
    package: values.package,
    version: values.version,
    artifactsDir: values['artifacts-dir'],
    bucket: values.bucket,
    region: values.region,
    platforms: values.platforms?.split(',').map(value => value.trim()).filter(Boolean),
    registryUrl: values.registry,
  })
}

const direct = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('upload-to-s3.ts')
if (direct) {
  main().catch((error) => {
    console.error(`Publish failed: ${(error as Error).message}`)
    process.exit(1)
  })
}
