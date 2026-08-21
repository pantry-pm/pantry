// craft-native.org recipe/catalog consistency.
//
// craft's repository was renamed from `home-lang/craft` to
// `craft-native/craft`. Every reference here kept working only because GitHub
// serves a 301 for the old path — a redirect that evaporates the moment
// anybody claims the vacated `home-lang/craft` name, at which point the
// version fetcher silently returns [] (it swallows !resp.ok) and the download
// URLs 404. Pin the canonical owner instead of relying on the redirect.

import { describe, expect, it } from 'bun:test'
import { pantry } from '../src/index'
import { recipe } from '../src/recipes/craft-native.org'

const pkg = (pantry as any).craftnativeorg
const script = (recipe.build?.script ?? []).join('\n')

describe('craft-native.org is registered', () => {
  it('resolves by domain key and by alias', () => {
    expect(pkg).toBeDefined()
    expect(pkg.domain).toBe('craft-native.org')
    expect((pantry as any).craft).toBe(pkg)
  })

  it('declares the same domain in the recipe and the catalog', () => {
    expect(recipe.domain).toBe(pkg.domain)
  })
})

describe('craft-native.org points at the canonical repository', () => {
  it('never references the pre-rename owner', () => {
    // A redirect is not a dependency you get to keep.
    expect(recipe.github).not.toContain('home-lang')
    expect(pkg.githubUrl).not.toContain('home-lang')
    expect(script).not.toContain('home-lang')
  })

  it('agrees between recipe, catalog, and download URL', () => {
    expect(recipe.github).toBe('https://github.com/craft-native/craft')
    expect(pkg.githubUrl).toBe(recipe.github)
    expect(script).toContain('https://github.com/craft-native/craft/releases/download/')
  })
})

describe('craft-native.org download script', () => {
  it('resolves an asset for every platform the recipe advertises', () => {
    // Each listed platform must hit a `case` arm; anything falling through to
    // `*)` exits 1 and the build fails on that platform only — the kind of
    // break that ships because CI happens not to cover that runner.
    const arms: Record<string, string> = {
      'darwin/aarch64': 'darwin+aarch64',
      'darwin/x86-64': 'darwin+x86-64',
      'linux/x86-64': 'linux+x86-64',
    }
    for (const platform of recipe.platforms ?? []) {
      const arm = arms[platform]
      expect(arm).toBeDefined()
      expect(script).toContain(`${arm})`)
    }
  })

  it('interpolates only variables the script itself defines', () => {
    // bun.com shipped broken for months because the script read $PLATFORM,
    // which buildkit never exports, collapsing every URL to `bun-.zip`.
    const defined = new Set(['VERSION', 'ASSET', 'URL'])
    for (const [, name] of script.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g))
      expect(defined).toContain(name)
  })

  it('installs the one program it advertises', () => {
    expect(pkg.programs).toEqual(['craft'])
    expect(script).toContain('install -Dm755 craft {{prefix}}/bin/craft')
  })
})

describe('craft-native.org version gate', () => {
  it('requires every asset the download script can ask for', () => {
    // The fetcher only catalogs releases carrying the full prebuilt set. If
    // that required list ever drifts from the assets the case arms name, the
    // catalog admits a version that cannot install on some platform.
    const source = recipe.versionSource as { type: string, fetch: () => Promise<string[]> }
    expect(source.type).toBe('custom')
    const body = source.fetch.toString()
    for (const asset of ['craft-darwin-arm64.zip', 'craft-darwin-x64.zip', 'craft-linux-x64.zip']) {
      expect(script).toContain(asset)
      expect(body).toContain(asset)
    }
  })
})
