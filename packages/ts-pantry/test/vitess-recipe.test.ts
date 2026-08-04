// vitess.io package/recipe consistency.
//
// A Vitess package is defined in three places that can drift independently:
//
//   1. `src/packages/vitessio.ts`  — what the registry ADVERTISES
//   2. `src/recipes/vitess.io.ts`  — what the build DECLARES
//   3. the `cp` loop inside that recipe's build script — what it actually INSTALLS
//
// Drift between them is silent and only surfaces at install time, as a
// package that promises a binary the tarball does not contain. These tests
// make the three agree by construction, so the failure happens in CI on the
// commit that caused it.

import { describe, expect, it } from 'bun:test'
import { pantry } from '../src/index'
import { recipe } from '../src/recipes/vitess.io'

const pkg = (pantry as any).vitessio

describe('vitess.io is registered', () => {
  it('resolves by domain key and by alias', () => {
    expect(pkg).toBeDefined()
    expect(pkg.domain).toBe('vitess.io')
    // The alias is what makes `pantry install vitess` work.
    expect((pantry as any).vitess).toBe(pkg)
  })

  it('points at the real upstream repository', () => {
    expect(pkg.githubUrl).toBe('https://github.com/vitessio/vitess')
    expect(recipe.github).toBe('https://github.com/vitessio/vitess')
  })
})

describe('the three program lists agree', () => {
  const installed = (): string[] => {
    // Extract the binaries the build script actually copies. Parsing the
    // script is the point: a name added to `programs` but not to the loop
    // would otherwise pass every other check and fail only on install.
    const script = recipe.build.script.map(s => (typeof s === 'string' ? s : String((s as any).run))).join('\n')
    const loop = script.split('\n').find(line => line.includes('for b in'))
    expect(loop).toBeDefined()
    const between = (loop as string).slice((loop as string).indexOf('for b in') + 'for b in'.length)
    return between.slice(0, between.indexOf(';')).trim().split(/\s+/)
  }

  it('the package advertises exactly what the recipe declares', () => {
    expect([...pkg.programs].sort()).toEqual([...recipe.programs].sort())
  })

  it('the recipe installs exactly what it declares', () => {
    expect(installed().sort()).toEqual([...recipe.programs].sort())
  })

  it('includes the daemons a cluster actually runs', () => {
    // A regression here would produce a package that installs but cannot run
    // a cluster, which is worse than one that fails to install.
    for (const required of ['vtgate', 'vttablet', 'vtctld', 'vtctldclient', 'vtorc'])
      expect(recipe.programs).toContain(required)
  })

  it('includes vtcombo, which the single-box preset depends on', () => {
    // Upstream's `make install` omits it because their packaging targets
    // production only; a dev cluster in one process needs it.
    expect(recipe.programs).toContain('vtcombo')
  })

  it('ships no test harnesses', () => {
    // `go build ./go/...` also emits these; copying them would bloat the
    // artifact and widen the attack surface for no benefit.
    for (const excluded of ['vtgateclienttest', 'vttestserver', 'zkctl', 'zkctld', 'zk'])
      expect(recipe.programs).not.toContain(excluded)
  })
})

describe('build configuration', () => {
  it('builds from source rather than repackaging the release', () => {
    // Vitess publishes one x86_64 tarball. Repackaging it would leave every
    // arm64 box unable to install, and would carry ~600MB of binaries and
    // fixtures no deployment uses.
    expect(recipe.distributable?.url).toContain('/archive/refs/tags/')
    expect(recipe.distributable?.url).not.toContain('/releases/download/')
  })

  it('compiles statically so the artifact is not tied to the build image libc', () => {
    expect(recipe.build.env?.CGO_ENABLED).toBe('0')
  })

  it('skips the vtadmin web build, which needs a Node toolchain', () => {
    const script = recipe.build.script.map(String).join('\n')
    expect(script).toContain('NOVTADMINBUILD=1')
  })

  it('requires a Go version that can actually build this source', () => {
    // Vitess v24 declares `go 1.26` in go.mod; an older toolchain fails with
    // an unhelpful module error.
    expect(recipe.buildDependencies?.['go.dev']).toBe('^1.26')
  })

  it('tracks upstream releases for version discovery', () => {
    expect(recipe.versionSource).toEqual({ type: 'github-releases', repo: 'vitessio/vitess' })
  })

  it('verifies the built binaries can start', () => {
    // The failure that matters most is a binary that compiled but cannot run
    // on the target platform.
    const test = recipe.test?.script.join('\n') ?? ''
    expect(test).toContain('vtgate --version')
    expect(test).toContain('vtctldclient --version')
  })
})

describe('version metadata', () => {
  it('lists versions newest first', () => {
    const parse = (v: string) => v.split('.').map(Number)
    for (let i = 1; i < pkg.versions.length; i++) {
      const [a, b] = [parse(pkg.versions[i - 1]), parse(pkg.versions[i])]
      const newer = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2]
      expect(newer).toBe(true)
    }
  })

  it('contains only stable releases', () => {
    // Pre-releases would be offered for install as if they were supported.
    for (const v of pkg.versions) expect(v).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('has no duplicates', () => {
    expect(new Set(pkg.versions).size).toBe(pkg.versions.length)
  })

  it('treats etcd and mysql as companions, not dependencies', () => {
    // Vitess stores topology in an external key-value store and manages MySQL
    // instances it does not provide; a cluster may point at an existing one
    // of either, so forcing them as dependencies would be wrong.
    expect(pkg.companions).toContain('etcd.io')
    expect(pkg.companions).toContain('mysql.com')
    expect(pkg.dependencies).toEqual([])
  })
})
