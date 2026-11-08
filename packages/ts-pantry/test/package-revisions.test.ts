import { expect, test } from 'bun:test'
import { recipeAllowsMirror, recipeBuildVersion, requireCurrentRecipeBuild, revisedPackageVersions } from '../scripts/package-revisions'
import { loadRecipe } from '../scripts/recipe-loader'
import { buildTokens, applyTokens } from '../scripts/buildkit'
import { compareVersions } from '../src/generate-zig'
import { compareVersionsDesc, resolveVersionFromMetadata } from '../src/version-utils'
import { parseInstallerConstraint, satisfiesInstallerConstraint } from '../src/installer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('packaging revisions preserve vendor releases and existing unrevised identities', () => {
  expect(revisedPackageVersions(['1.2.3', '1.2.2'])).toEqual(['1.2.3', '1.2.2'])
  expect(revisedPackageVersions(['155.0.8059.84', '154.0.1.2'], { '155.0.8059.84': 1 }))
    .toEqual(['155.0.8059.84.1', '154.0.1.2'])
  expect(recipeBuildVersion('155.0.8059.84.1', { '155.0.8059.84': 1 }))
    .toEqual({ upstream: '155.0.8059.84', current: '155.0.8059.84.1' })
})

test('historical revisions remain readable but cannot replace accepted package identities', () => {
  for (const version of ['1.2.3', '1.2.3.1']) {
    const identity = recipeBuildVersion(version, { '1.2.3': 2 })
    expect(identity).toEqual({ upstream: '1.2.3', current: '1.2.3.2' })
    expect(() => requireCurrentRecipeBuild(version, identity.current)).toThrow('refusing to replace')
  }
  expect(() => requireCurrentRecipeBuild('1.2.3.2', '1.2.3.2')).not.toThrow()
  expect(() => recipeBuildVersion('1.2.3.3', { '1.2.3': 2 })).toThrow('Undeclared')
})

test('native mirrors cannot bypass a packaging repair or replace its accepted predecessor', () => {
  const revisions = { '1.2.3': 1 }
  expect(recipeAllowsMirror('1.2.3.1', recipeBuildVersion('1.2.3.1', revisions))).toBe(false)
  expect(() => recipeAllowsMirror('1.2.3', recipeBuildVersion('1.2.3', revisions))).toThrow('refusing to replace')
  expect(recipeAllowsMirror('1.2.4', recipeBuildVersion('1.2.4', revisions))).toBe(true)
  expect(recipeAllowsMirror('1.2.4', recipeBuildVersion('1.2.4', revisions), true)).toBe(false)
})

test('PostgreSQL two-component releases keep their vendor identity when client tools are repackaged', async () => {
  const loaded = await loadRecipe('postgresql.org', 'linux-x86-64', '18.6.1')
  expect(loaded.upstreamVersion).toBe('18.6')
  expect(loaded.publicationVersion).toBe('18.6.1')
  expect(loaded.requiresRecipeBuild).toBe(true)
  expect(recipeAllowsMirror('18.6.1', { upstream: loaded.upstreamVersion!, current: loaded.publicationVersion! })).toBe(false)
  expect(() => requireCurrentRecipeBuild('18.6', loaded.publicationVersion!)).toThrow('refusing to replace')
  const tokens = buildTokens('postgresql.org', loaded.upstreamVersion!, 'linux-x86-64', '/package/v18.6.1', '/source', {})
  expect(applyTokens(loaded.recipe.distributable!.url, tokens)).toContain('/REL_18_6.tar.gz')
})

test('PostgreSQL runtime dependencies rebuild their macOS 14 packaging without replacing vendor identities', async () => {
  for (const [domain, upstream, publication] of [
    ['invisible-island.net/ncurses', '6.6.0', '6.6.0.1'],
    ['zlib.net', '1.3.2', '1.3.2.1'],
    ['gnu.org/readline', '8.3.0', '8.3.0.1'],
  ]) {
    const loaded = await loadRecipe(domain, 'darwin-arm64', publication)
    expect(loaded.upstreamVersion).toBe(upstream)
    expect(loaded.publicationVersion).toBe(publication)
    expect(loaded.requiresRecipeBuild).toBe(true)
    expect(loaded.recipe.build?.env?.darwin?.MACOSX_DEPLOYMENT_TARGET).toBe('14.0')
    expect(recipeAllowsMirror(publication, { upstream, current: publication })).toBe(false)
    expect(() => requireCurrentRecipeBuild(upstream, publication)).toThrow('refusing to replace')
    const tokens = buildTokens(domain, upstream, 'darwin-arm64', '/package/' + publication, '/source', {})
    expect(applyTokens(loaded.recipe.distributable!.url, tokens)).not.toContain(publication)
    if (domain === 'zlib.net')
      expect(applyTokens(loaded.recipe.distributable!.url, tokens)).toBe('https://zlib.net/fossils/zlib-1.3.2.tar.gz')
  }
})

test('ambiguous tuples and invalid revisions fail before catalog generation or a build', () => {
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => revisedPackageVersions(['1.2.3'], { '1.2.3': revision })).toThrow('Invalid')
  expect(() => revisedPackageVersions(['1.2.3.1'], { '1.2.3': 1 })).toThrow('conflicts')
  expect(() => revisedPackageVersions(['1.2.3'], { '1.2.3': 1, '1.2.3.4': 1 })).toThrow('fixed numeric')
  expect(() => recipeBuildVersion('1.2.3.01', { '1.2.3': 2 })).toThrow('Undeclared')
})

test('the normal recipe loader and build tokens download the vendor version for the revised package', async () => {
  const loaded = await loadRecipe('google.com/chrome', 'linux-x86-64', '155.0.8059.84.1')
  expect(loaded.upstreamVersion).toBe('155.0.8059.84')
  expect(loaded.publicationVersion).toBe('155.0.8059.84.1')
  expect(loaded.requiresRecipeBuild).toBe(true)
  expect((await loadRecipe('google.com/chrome', 'linux-x86-64', '155.0.8059.85')).requiresRecipeBuild).toBe(true)
  const tokens = buildTokens('google.com/chrome', loaded.upstreamVersion!, 'linux-x86-64', '/package/v155.0.8059.84.1', '/source', {})
  const script = applyTokens((loaded.recipe.build!.script as string[]).join('\n'), tokens)
  expect(script).toContain('chrome-for-testing-public/155.0.8059.84/linux64/')
  expect(script).not.toContain('chrome-for-testing-public/155.0.8059.84.1/')
  expect(script).toContain('/package/v155.0.8059.84.1/lib')
})

test('both JavaScript catalogs and installer bounds preserve all five identity components', () => {
  const base = '155.0.8059.84'
  const revised = `${base}.1`
  for (const compare of [compareVersions, compareVersionsDesc]) {
    expect(compare(revised, base)).toBeLessThan(0)
    expect(compare(`${base}.2`, '155.0.8059.85')).toBeGreaterThan(0)
  }
  expect(resolveVersionFromMetadata(revised, [base, revised])).toBe(revised)
  expect(resolveVersionFromMetadata(`${base}.2`, [base, revised])).toBeNull()
  expect(satisfiesInstallerConstraint(base, parseInstallerConstraint(`>=${revised}`)!)).toBe(false)
  expect(satisfiesInstallerConstraint(`${base}.2`, parseInstallerConstraint(`<=${revised}`)!)).toBe(false)
})

test('packaging repairs do not block a vendor changing its unrelated release tuple length', () => {
  expect(revisedPackageVersions(['1.4', '1.3.2'], { '1.3.2': 1 })).toEqual(['1.4', '1.3.2.1'])
})

test('the normal version updater checks declared packaging repairs without an upstream version source', () => {
  const metadata = resolve(import.meta.dir, '../src/packages/gnu.org/readline.ts')
  const before = readFileSync(metadata, 'utf8')
  const result = Bun.spawnSync([process.execPath, '--no-env-file', resolve(import.meta.dir, '../scripts/version-fetcher.ts'), '--domain', 'gnu.org/readline', '--dry-run'])
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('Done: 1 checked,')
  expect(readFileSync(metadata, 'utf8')).toBe(before)
})
