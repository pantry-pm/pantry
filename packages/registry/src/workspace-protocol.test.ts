import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findWorkspaceRoot,
  manifestUsesWorkspaceProtocol,
  resolveWorkspacePackages,
  resolveWorkspaceSpec,
  rewriteManifestForPublish,
  rewritePackageJsonContent,
  rewriteWorkspaceRanges,
  UnresolvableWorkspaceDependencyError,
} from './workspace-protocol'
import type { WorkspacePackage } from './workspace-protocol'

// ============================================================================
// Fixture helpers
// ============================================================================

let fixtureDirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pantry-ws-protocol-'))
  fixtureDirs.push(dir)
  return dir
}

function writeManifest(dir: string, manifest: Record<string, any>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Build a workspace: root with `packages/*` globs plus member packages. */
function makeWorkspace(members: Record<string, Record<string, any>>, workspaces: any = ['packages/*']): { root: string, pkgDir: (name: string) => string } {
  const root = makeDir()
  writeManifest(root, { name: 'ws-root', private: true, workspaces })
  for (const [dir, manifest] of Object.entries(members)) {
    writeManifest(join(root, 'packages', dir), manifest)
  }
  return { root, pkgDir: name => join(root, 'packages', name) }
}

beforeEach(() => {
  fixtureDirs = []
})

afterEach(() => {
  for (const dir of fixtureDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  fixtureDirs = []
})

function pkgMap(entries: Record<string, string | undefined>): Map<string, WorkspacePackage> {
  const map = new Map<string, WorkspacePackage>()
  for (const [name, version] of Object.entries(entries)) {
    map.set(name, { name, version, dir: `/fake/${name}` })
  }
  return map
}

// ============================================================================
// resolveWorkspaceSpec
// ============================================================================

describe('resolveWorkspaceSpec', () => {
  it('maps * to the exact version', () => {
    expect(resolveWorkspaceSpec('*', '0.1.0')).toBe('0.1.0')
  })

  it('maps the bare spec to the exact version', () => {
    expect(resolveWorkspaceSpec('', '0.1.0')).toBe('0.1.0')
  })

  it('maps ^ to a caret range', () => {
    expect(resolveWorkspaceSpec('^', '0.1.0')).toBe('^0.1.0')
  })

  it('maps ~ to a tilde range', () => {
    expect(resolveWorkspaceSpec('~', '0.1.0')).toBe('~0.1.0')
  })

  it('keeps an explicit range verbatim, dropping the protocol prefix', () => {
    expect(resolveWorkspaceSpec('^1.2.3', '2.0.0')).toBe('^1.2.3')
    expect(resolveWorkspaceSpec('1.2.3', '2.0.0')).toBe('1.2.3')
  })
})

// ============================================================================
// rewriteWorkspaceRanges (pure, against a resolved package map)
// ============================================================================

describe('rewriteWorkspaceRanges', () => {
  const packages = pkgMap({ '@ws/core': '0.2.9', '@ws/utils': '1.0.0' })

  it('rewrites workspace:* to the exact version', () => {
    const { manifest, resolutions } = rewriteWorkspaceRanges({
      name: '@ws/app',
      dependencies: { '@ws/core': 'workspace:*' },
    }, packages)

    expect(manifest.dependencies['@ws/core']).toBe('0.2.9')
    expect(resolutions).toEqual([{ name: '@ws/core', section: 'dependencies', from: 'workspace:*', to: '0.2.9' }])
  })

  it('rewrites workspace:^ and workspace:~ to caret/tilde ranges', () => {
    const { manifest } = rewriteWorkspaceRanges({
      dependencies: { '@ws/core': 'workspace:^', '@ws/utils': 'workspace:~' },
    }, packages)

    expect(manifest.dependencies['@ws/core']).toBe('^0.2.9')
    expect(manifest.dependencies['@ws/utils']).toBe('~1.0.0')
  })

  it('rewrites bare workspace: to the exact version', () => {
    const { manifest } = rewriteWorkspaceRanges({
      dependencies: { '@ws/core': 'workspace:' },
    }, packages)

    expect(manifest.dependencies['@ws/core']).toBe('0.2.9')
  })

  it('rewrites across dependencies, devDependencies, peerDependencies, and optionalDependencies', () => {
    const { manifest } = rewriteWorkspaceRanges({
      dependencies: { '@ws/core': 'workspace:*' },
      devDependencies: { '@ws/utils': 'workspace:*' },
      peerDependencies: { '@ws/core': 'workspace:^' },
      optionalDependencies: { '@ws/utils': 'workspace:~' },
    }, packages)

    expect(manifest.dependencies['@ws/core']).toBe('0.2.9')
    expect(manifest.devDependencies['@ws/utils']).toBe('1.0.0')
    expect(manifest.peerDependencies['@ws/core']).toBe('^0.2.9')
    expect(manifest.optionalDependencies['@ws/utils']).toBe('~1.0.0')
  })

  it('leaves non-workspace ranges untouched', () => {
    const input = {
      dependencies: {
        'left-pad': '^1.3.0',
        '@ws/core': 'workspace:*',
        'local-thing': 'file:../local-thing',
        'linked-thing': 'link:../linked-thing',
      },
    }
    const { manifest } = rewriteWorkspaceRanges(input, packages)

    expect(manifest.dependencies['left-pad']).toBe('^1.3.0')
    expect(manifest.dependencies['local-thing']).toBe('file:../local-thing')
    expect(manifest.dependencies['linked-thing']).toBe('link:../linked-thing')
    expect(manifest.dependencies['@ws/core']).toBe('0.2.9')
  })

  it('returns the original reference when nothing needs rewriting', () => {
    const input = { dependencies: { 'left-pad': '^1.3.0' } }
    const { manifest, resolutions } = rewriteWorkspaceRanges(input, packages)

    expect(manifest).toBe(input)
    expect(resolutions).toEqual([])
  })

  it('does not mutate the input manifest', () => {
    const input = { dependencies: { '@ws/core': 'workspace:*' } }
    rewriteWorkspaceRanges(input, packages)

    expect(input.dependencies['@ws/core']).toBe('workspace:*')
  })

  it('fails loudly naming the dependency when it is not a workspace package', () => {
    expect(() => rewriteWorkspaceRanges({
      name: '@ws/app',
      dependencies: { '@ws/missing': 'workspace:*' },
    }, packages)).toThrow(UnresolvableWorkspaceDependencyError)

    try {
      rewriteWorkspaceRanges({
        name: '@ws/app',
        dependencies: { '@ws/missing': 'workspace:*' },
      }, packages)
      expect.unreachable('should have thrown')
    }
    catch (err) {
      const error = err as UnresolvableWorkspaceDependencyError
      expect(error.message).toContain('@ws/missing')
      expect(error.message).toContain('workspace:*')
      expect(error.dependency).toBe('@ws/missing')
    }
  })

  it('fails loudly when the workspace package has no version', () => {
    const withoutVersion = pkgMap({ '@ws/core': undefined })
    expect(() => rewriteWorkspaceRanges({
      dependencies: { '@ws/core': 'workspace:*' },
    }, withoutVersion)).toThrow(/no "version" field/)
  })
})

// ============================================================================
// Workspace discovery from the repo being published
// ============================================================================

describe('workspace discovery', () => {
  it('finds the workspace root by walking up from the package dir', () => {
    const { root, pkgDir } = makeWorkspace({ app: { name: 'app', version: '1.0.0' } })
    expect(findWorkspaceRoot(pkgDir('app'))).toBe(root)
  })

  it('returns null when no ancestor declares workspaces', () => {
    const dir = makeDir()
    writeManifest(dir, { name: 'standalone', version: '1.0.0' })
    expect(findWorkspaceRoot(dir)).toBeNull()
  })

  it('discovers member packages from workspaces globs', () => {
    const { root } = makeWorkspace({
      core: { name: '@ws/core', version: '0.2.9' },
      utils: { name: '@ws/utils', version: '1.0.0' },
    })

    const packages = resolveWorkspacePackages(root)
    expect(packages.get('@ws/core')?.version).toBe('0.2.9')
    expect(packages.get('@ws/utils')?.version).toBe('1.0.0')
  })

  it('supports the { packages: [...] } workspaces object form', () => {
    const { root } = makeWorkspace(
      { core: { name: '@ws/core', version: '0.2.9' } },
      { packages: ['packages/*'] },
    )

    const packages = resolveWorkspacePackages(root)
    expect(packages.get('@ws/core')?.version).toBe('0.2.9')
  })

  it('supports nested glob layouts', () => {
    const root = makeDir()
    writeManifest(root, { name: 'ws-root', private: true, workspaces: ['packages/**'] })
    writeManifest(join(root, 'packages', 'collections', 'foo'), { name: '@ws/foo', version: '3.1.4' })

    const packages = resolveWorkspacePackages(root)
    expect(packages.get('@ws/foo')?.version).toBe('3.1.4')
  })
})

// ============================================================================
// rewriteManifestForPublish (discovery + rewrite)
// ============================================================================

describe('rewriteManifestForPublish', () => {
  it('resolves versions from the workspace being published', () => {
    const { pkgDir } = makeWorkspace({
      core: { name: '@ws/core', version: '0.2.9' },
      app: { name: '@ws/app', version: '1.0.0' },
    })

    const { manifest, resolutions } = rewriteManifestForPublish({
      name: '@ws/app',
      dependencies: { '@ws/core': 'workspace:*' },
    }, pkgDir('app'))

    expect(manifest.dependencies['@ws/core']).toBe('0.2.9')
    expect(resolutions).toHaveLength(1)
  })

  it('fails loudly when a workspace root cannot be found', () => {
    const dir = makeDir()
    writeManifest(dir, { name: 'standalone', version: '1.0.0' })

    expect(() => rewriteManifestForPublish({
      name: 'standalone',
      dependencies: { '@ws/core': 'workspace:*' },
    }, dir)).toThrow(/no workspace root/)
  })

  it('fails loudly naming the dependency when it is not part of the workspace', () => {
    const { pkgDir } = makeWorkspace({
      app: { name: '@ws/app', version: '1.0.0' },
    })

    try {
      rewriteManifestForPublish({
        name: '@ws/app',
        dependencies: { '@ws/external': 'workspace:*' },
      }, pkgDir('app'))
      expect.unreachable('should have thrown')
    }
    catch (err) {
      expect(err).toBeInstanceOf(UnresolvableWorkspaceDependencyError)
      expect((err as Error).message).toContain('@ws/external')
    }
  })
})

// ============================================================================
// rewritePackageJsonContent (raw manifest content in/out)
// ============================================================================

describe('rewritePackageJsonContent', () => {
  it('returns rewritten content when workspace refs are present', () => {
    const { pkgDir } = makeWorkspace({
      core: { name: '@ws/core', version: '0.2.9' },
      app: { name: '@ws/app', version: '1.0.0' },
    })

    const content = readFileSync(join(pkgDir('app'), 'package.json'), 'utf-8')
    const withDeps = JSON.stringify({
      ...JSON.parse(content),
      dependencies: { '@ws/core': 'workspace:^' },
    })

    const result = rewritePackageJsonContent(withDeps, pkgDir('app'))
    expect(result.rewritten).toBe(true)
    expect(JSON.parse(result.content).dependencies['@ws/core']).toBe('^0.2.9')
  })

  it('returns the original content untouched when there is nothing to rewrite', () => {
    const { pkgDir } = makeWorkspace({
      app: { name: '@ws/app', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' } },
    })

    const content = readFileSync(join(pkgDir('app'), 'package.json'), 'utf-8')
    const result = rewritePackageJsonContent(content, pkgDir('app'))
    expect(result.rewritten).toBe(false)
    expect(result.content).toBe(content)
  })
})

// ============================================================================
// manifestUsesWorkspaceProtocol
// ============================================================================

describe('manifestUsesWorkspaceProtocol', () => {
  it('detects workspace refs in any section', () => {
    expect(manifestUsesWorkspaceProtocol({ optionalDependencies: { a: 'workspace:*' } })).toBe(true)
    expect(manifestUsesWorkspaceProtocol({ peerDependencies: { a: 'workspace:^' } })).toBe(true)
  })

  it('returns false for ordinary manifests', () => {
    expect(manifestUsesWorkspaceProtocol({ dependencies: { a: '^1.0.0' } })).toBe(false)
    expect(manifestUsesWorkspaceProtocol({})).toBe(false)
    expect(manifestUsesWorkspaceProtocol({ dependencies: 'not-an-object' })).toBe(false)
  })
})
