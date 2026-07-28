import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface ReleaseManifestAsset {
  name: string
  size: number
  sha256: string
}

export interface ReleaseManifest {
  schemaVersion: 1
  repository: string
  tag: string
  commit: string
  generatedAt: string
  assets: ReleaseManifestAsset[]
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function createReleaseManifest(options: {
  repository: string
  tag: string
  commit?: string
  generatedAt?: string
  files: string[]
}): ReleaseManifest {
  return {
    schemaVersion: 1,
    repository: options.repository,
    tag: options.tag,
    commit: options.commit || '',
    generatedAt: options.generatedAt || new Date().toISOString(),
    assets: options.files.map(file => ({
      name: path.basename(file),
      size: fs.statSync(file).size,
      sha256: sha256File(file),
    })),
  }
}

export function writeReleaseManifest(file: string, manifest: ReleaseManifest): void {
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
}
