import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pack } from './pack'
import { UnresolvableWorkspaceDependencyError } from '../src/workspace-protocol'

/**
 * Integration tests for the pack path: the packed tarball must carry
 * rewritten workspace: ranges while the repo's own package.json stays
 * byte-for-byte untouched.
 */

const fixtureDirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pantry-pack-ws-'))
  fixtureDirs.push(dir)
  return dir
}

function writeManifest(dir: string, manifest: Record<string, any>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function makeWorkspace(members: Record<string, Record<string, any>>): { root: string, pkgDir: (name: string) => string } {
  const root = makeDir()
  writeManifest(root, { name: 'ws-root', private: true, workspaces: ['packages/*'] })
  for (const [dir, manifest] of Object.entries(members)) {
    writeManifest(join(root, 'packages', dir), manifest)
  }
  return { root, pkgDir: name => join(root, 'packages', name) }
}

function extractTarball(tarballPath: string): string {
  const outDir = makeDir()
  execFileSync('tar', ['-xzf', tarballPath, '-C', outDir])
  return outDir
}

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('pack workspace: protocol rewriting', () => {
  it('packs rewritten workspace ranges and leaves the on-disk manifest untouched', async () => {
    const { pkgDir } = makeWorkspace({
      core: { name: '@ws/core', version: '0.2.9' },
      app: {
        'name': '@ws/app',
        'version': '1.0.0',
        'dependencies': { '@ws/core': 'workspace:*', 'left-pad': '^1.3.0' },
        'peerDependencies': { '@ws/core': 'workspace:^' },
        'optionalDependencies': { '@ws/core': 'workspace:~' },
      },
    })

    const appDir = pkgDir('app')
    const before = readFileSync(join(appDir, 'package.json'), 'utf-8')

    const tarballPath = await pack(appDir)
    const outDir = extractTarball(tarballPath)
    const packed = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf-8'))

    expect(packed.dependencies['@ws/core']).toBe('0.2.9')
    expect(packed.dependencies['left-pad']).toBe('^1.3.0')
    expect(packed.peerDependencies['@ws/core']).toBe('^0.2.9')
    expect(packed.optionalDependencies['@ws/core']).toBe('~0.2.9')

    // The repo's own package.json must not be modified
    expect(readFileSync(join(appDir, 'package.json'), 'utf-8')).toBe(before)
  })

  it('packs the original manifest byte-for-byte when nothing needs rewriting', async () => {
    const { pkgDir } = makeWorkspace({
      app: { name: '@ws/app', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' } },
    })

    const appDir = pkgDir('app')
    const before = readFileSync(join(appDir, 'package.json'), 'utf-8')

    const tarballPath = await pack(appDir)
    const outDir = extractTarball(tarballPath)

    expect(readFileSync(join(outDir, 'package.json'), 'utf-8')).toBe(before)
  })

  it('fails loudly naming the dependency when a workspace ref cannot be resolved', async () => {
    const { pkgDir } = makeWorkspace({
      app: { name: '@ws/app', version: '1.0.0', dependencies: { '@ws/missing': 'workspace:*' } },
    })

    await expect(pack(pkgDir('app'))).rejects.toThrow(UnresolvableWorkspaceDependencyError)
    await expect(pack(pkgDir('app'))).rejects.toThrow(/@ws\/missing/)
  })
})
