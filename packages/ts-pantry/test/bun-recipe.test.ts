// bun.com recipe/catalog consistency.
//
// Bun's install path had two independent breaks that both failed silently at
// build time rather than in CI:
//
//   1. The build script interpolated `$PLATFORM`, a shell variable buildkit
//      never exports, so every download URL resolved to `bun-.zip` and curl
//      404'd — on every platform, for every version.
//   2. The release-tag pattern captured the `v` in `bun-v1.4.0`, so discovered
//      versions were `v1.4.0` — not semver, dropped on the floor. The catalog
//      sat at 1.3.14 while bun shipped 1.4.
//
// Both are properties of the recipe that can be checked without a network,
// so they are checked here.

import { describe, expect, it } from 'bun:test'
import { pantry } from '../src/index'
import { recipe } from '../src/recipes/bun.com'

const pkg = (pantry as any).buncom
const script = (recipe.build?.script ?? []).join('\n')

describe('bun.com is registered', () => {
  it('resolves by domain key and by alias', () => {
    expect(pkg).toBeDefined()
    expect(pkg.domain).toBe('bun.com')
    // The alias is what makes `pantry install bun` work.
    expect((pantry as any).bun).toBe(pkg)
  })

  it('declares the same domain in the recipe and the catalog', () => {
    // Binaries are published under, and looked up by, the canonical domain.
    // When these disagree the registry answers "no versions" for a package it
    // is in fact hosting — which is exactly how bun became uninstallable.
    expect(recipe.domain).toBe(pkg.domain)
  })

  it('advertises both programs the tarball installs', () => {
    expect(pkg.programs).toEqual(['bun', 'bunx'])
    for (const program of pkg.programs)
      expect(script).toContain(`{{prefix}}/bin/${program}`)
  })
})

describe('bun.com build script', () => {
  it('uses no shell variable the build environment does not define', () => {
    // `$PLATFORM` was the specific offender. Any bare `$NAME` that the script
    // does not itself assign is the same class of bug.
    const referenced = [...script.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)].map(m => m[1])
    // Assignments are not always line-initial — a `case` arm puts one after
    // `) `, which is where ASSET is set.
    const assigned = new Set([...script.matchAll(/(?:^|[\s;)])([A-Z_][A-Z0-9_]*)=/gm)].map(m => m[1]))
    for (const name of referenced)
      expect({ name, assigned: assigned.has(name) }).toEqual({ name, assigned: true })
  })

  it('maps every platform pantry builds for to a real release asset', () => {
    // bun's asset names use its own triple — `x64`, not pantry's `x86-64` —
    // so the mapping is spelled out and each arm has to be present.
    for (const target of ['darwin+aarch64', 'darwin+x86-64', 'linux+aarch64', 'linux+x86-64'])
      expect(script).toContain(`${target})`)
  })

  it('templates the platform through the build context, not the shell', () => {
    expect(script).toContain('{{hw.platform}}')
    expect(script).toContain('{{hw.arch}}')
  })

  it('installs into the prefix rather than the build directory', () => {
    // Without this the build "succeeds" and packages an empty tree.
    expect(script).toContain('install -Dm755 bun "{{prefix}}/bin/bun"')
  })
})

describe('bun.com version discovery', () => {
  it('strips the v from a bun-vX.Y.Z release tag', () => {
    const source = recipe.versionSource
    expect(source?.type).toBe('github-releases')

    const pattern = (source as { tagPattern?: RegExp }).tagPattern
    expect(pattern).toBeDefined()

    const captured = 'bun-v1.4.0'.match(pattern!)?.[1]
    expect(captured).toBe('1.4.0')
  })

  it('carries a version newer than the one the broken pattern froze it at', () => {
    // 1.3.14 was the last version seeded before discovery silently stopped.
    const [major, minor] = pkg.versions[0].split('.').map(Number)
    expect(major * 1000 + minor).toBeGreaterThan(1 * 1000 + 3)
  })
})
