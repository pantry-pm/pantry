import { expect, test } from 'bun:test'
import { recipeAllowsMirror, recipeBuildVersion, requireCurrentRecipeBuild, revisedPackageVersions, revisionIdentity } from '../scripts/package-revisions'
import { loadRecipe } from '../scripts/recipe-loader'
import { buildTokens, applyTokens } from '../scripts/buildkit'
import { compareVersions } from '../src/generate-zig'
import { compareVersionsDesc, resolveVersionFromMetadata } from '../src/version-utils'
import { parseInstallerConstraint, satisfiesInstallerConstraint } from '../src/installer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { llvmorgPackage } from '../src/packages/llvmorg'
import { versionSatisfies } from '../scripts/build-package'

test('Zig package cache repair retains vendor and prerelease identities', async () => {
  expect(revisedPackageVersions(['0.18.0-dev.1005+75d48dfff', '0.17.1', '0.17.0'], { '0.17.1': 1 }))
    .toEqual(['0.18.0-dev.1005+75d48dfff', '0.17.1.1', '0.17.0'])
  for (const platform of ['darwin-arm64', 'darwin-x86-64', 'linux-x86-64', 'linux-arm64']) {
    const loaded = await loadRecipe('ziglang.org', platform, '0.17.1.1')
    expect(loaded.upstreamVersion).toBe('0.17.1')
    expect(loaded.publicationVersion).toBe('0.17.1.1')
    expect(loaded.requiresRecipeBuild).toBe(true)
    expect(recipeAllowsMirror('0.17.1.1', { upstream: loaded.upstreamVersion!, current: loaded.publicationVersion! }, loaded.requiresRecipeBuild)).toBe(false)
    expect(() => requireCurrentRecipeBuild('0.17.1', loaded.publicationVersion!)).toThrow('refusing to replace')
    expect(loaded.recipe.build?.dependencies?.['gnu.org/patch']).toBe('^2.8')
    const tokens = buildTokens('ziglang.org', loaded.upstreamVersion!, platform, '/package/v0.17.1.1', '/source', {})
    const script = applyTokens((loaded.recipe.build!.script as string[]).join('\n'), tokens)
    expect(script).toContain('VERSION=0.17.1\n')
    expect(script).toContain('patch -d "/package/v0.17.1.1" -p1 < props/fetch-package-cache.patch')
    expect(script).toContain('sh props/verify-fetch-cache.sh "/package/v0.17.1.1/bin/zig"')
    expect(loaded.recipe.test?.required).toBe(true)
  }
})

test('the LLVM runtime repair executes its owned recipe and retains the vendor source identity', async () => {
  for (const platform of ['darwin-arm64', 'linux-x86-64', 'linux-arm64']) {
    const loaded = await loadRecipe('llvm.org', platform, '23.1.5.2')
    expect(loaded.upstreamVersion).toBe('23.1.5')
    expect(loaded.publicationVersion).toBe('23.1.5.2')
    expect(loaded.requiresRecipeBuild).toBe(true)
    expect(recipeAllowsMirror('23.1.5.2', {
      upstream: loaded.upstreamVersion!, current: loaded.publicationVersion!,
    }, loaded.requiresRecipeBuild)).toBe(false)
    expect(() => requireCurrentRecipeBuild('23.1.5', loaded.publicationVersion!)).toThrow('refusing to replace')
    const tokens = buildTokens('llvm.org', loaded.upstreamVersion!, platform, '/package/v23.1.5.2', '/source', {})
    expect(applyTokens(loaded.recipe.distributable!.url, tokens)).toBe('https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.5/llvm-project-23.1.5.src.tar.xz')
    expect(loaded.recipe.test?.required).toBe(true)
    const constraint = loaded.recipe.dependencies?.['invisible-island.net/ncurses']
    expect(constraint).toBeString()
    expect(versionSatisfies('6.6.0', constraint)).toBe(false)
    expect(versionSatisfies('6.6.0.1', constraint)).toBe(true)
  }
  expect(llvmorgPackage.versions[0]).toBe('23.1.5.2')
  expect(llvmorgPackage.dependencies).toContain('invisible-island.net/ncurses^6.6.0.1')
})

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

test('PostgreSQL two-component releases are repaired in place under their vendor identity', async () => {
  // 18.6.1 read as a vendor patch release; the repair now replaces 18.6 itself.
  const loaded = await loadRecipe('postgresql.org', 'linux-x86-64', '18.6')
  expect(loaded.upstreamVersion).toBe('18.6')
  expect(loaded.publicationVersion).toBe('18.6')
  expect(() => requireCurrentRecipeBuild('18.6', loaded.publicationVersion!)).not.toThrow()
  const tokens = buildTokens('postgresql.org', loaded.upstreamVersion!, 'linux-x86-64', '/package/v18.6', '/source', {})
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

test('PostgreSQL 17 closure repairs rebuild 17.11 from the original vendor source', async () => {
  for (const platform of ['darwin-arm64', 'linux-x86-64'] as const) {
    const loaded = await loadRecipe('postgresql.org', platform, '17.11')
    expect(loaded.upstreamVersion).toBe('17.11')
    expect(loaded.publicationVersion).toBe('17.11')
    const tokens = buildTokens('postgresql.org', loaded.upstreamVersion!, platform, '/package/v17.11', '/source', {})
    expect(applyTokens(loaded.recipe.distributable!.url, tokens)).toContain('/REL_17_11.tar.gz')
    expect(loaded.recipe.test?.required).toBe(true)
    expect(loaded.recipe.test?.script.join('\n')).toContain('psql')
    expect(loaded.recipe.test?.script.join('\n')).toContain('env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH')
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
  const loaded = await loadRecipe('google.com/chrome', 'linux-x86-64', '155.0.8059.84.2')
  expect(loaded.upstreamVersion).toBe('155.0.8059.84')
  expect(loaded.publicationVersion).toBe('155.0.8059.84.2')
  expect(loaded.requiresRecipeBuild).toBe(true)
  expect((await loadRecipe('google.com/chrome', 'linux-x86-64', '155.0.8059.85')).requiresRecipeBuild).toBe(true)
  const tokens = buildTokens('google.com/chrome', loaded.upstreamVersion!, 'linux-x86-64', '/package/v155.0.8059.84.2', '/source', {})
  const script = applyTokens((loaded.recipe.build!.script as string[]).join('\n'), tokens)
  expect(script).toContain('chrome-for-testing-public/155.0.8059.84/linux64/')
  expect(script).not.toContain('chrome-for-testing-public/155.0.8059.84.2/')
  expect(script).toContain('/package/v155.0.8059.84.2/lib')
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

test('the native catalog names every recipe build revision, so installs can replace defective builds', async () => {
  const { zigBuildRevisions } = await import('../src/generate-zig')
  expect(zigBuildRevisions(undefined)).toBe('')
  expect(zigBuildRevisions({ '1.5.7': 2 })).toBe('\n        .build_revisions = &[_]BuildRevision{ .{ .release = "1.5.7", .revision = 2 } },')
  expect(zigBuildRevisions({ '3.15.0rc1': 1 })).toContain('.release = "3.15.0rc1", .revision = 1')
  expect(() => zigBuildRevisions({ '1.0.0+abc': 1 })).toThrow('Invalid package build revision')

  const { readdirSync, statSync } = await import('node:fs')
  const recipesDir = resolve(import.meta.dir, '../src/recipes')
  const catalog = readFileSync(resolve(import.meta.dir, '../../zig/src/packages/generated.zig'), 'utf8')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name)
      if (statSync(path).isDirectory()) { if (name !== 'props') walk(path) }
      else if (name.endsWith('.ts')) files.push(path)
    }
  }
  walk(recipesDir)
  let revised = 0
  for (const file of files) {
    const recipe = (await import(file)).recipe
    if (!recipe?.revisions || !Object.keys(recipe.revisions).length) continue
    revised++
    const start = catalog.indexOf(`.domain = "${recipe.domain}",`)
    expect(start).toBeGreaterThan(0)
    const entry = catalog.slice(start, catalog.indexOf('\n    }', start))
    for (const [release, revision] of Object.entries(recipe.revisions))
      expect(entry).toContain(`.release = "${release}", .revision = ${revision} }`)
  }
  expect(revised).toBeGreaterThan(0)
})

test('an ELF loader-path revision may mirror and normalise, applies to Linux only, and keeps later releases mirrorable', async () => {
  const { recipeRequiresBuild, revisionReason, revisionAppliesTo, validateRevisionReasons } = await import('../scripts/package-revisions')
  const revisions = { '1.2.3': 1 }
  const reasons = { '1.2.3': 'elf-loader-paths' } as const
  expect(validateRevisionReasons(revisions, reasons)).toBeUndefined()
  expect(() => validateRevisionReasons(revisions, { '1.2.4': 'elf-loader-paths' })).toThrow('no revision')
  expect(() => validateRevisionReasons(revisions, { '1.2.3': 'other' as never })).toThrow('Unknown revision reason')

  expect(revisionReason('1.2.3.1', revisions, reasons)).toBe('elf-loader-paths')
  expect(revisionReason('1.2.3', revisions, reasons)).toBeUndefined()
  expect(revisionReason('1.2.4', revisions, reasons)).toBeUndefined()
  // The repair is a mirrored vendor build with normalised loader paths.
  expect(recipeAllowsMirror('1.2.3.1', recipeBuildVersion('1.2.3.1', revisions), recipeRequiresBuild(revisions, reasons), 'elf-loader-paths')).toBe(true)
  // Any other revision still executes the recipe.
  expect(recipeAllowsMirror('1.2.3.1', recipeBuildVersion('1.2.3.1', revisions), recipeRequiresBuild(revisions, {}))).toBe(false)
  expect(recipeRequiresBuild(revisions, {})).toBe(true)
  expect(recipeRequiresBuild(revisions, reasons)).toBe(false)
  expect(recipeRequiresBuild({ '1.2.3': 1, '1.2.4': 1 }, reasons)).toBe(true)
  // A later vendor release stays a plain mirror.
  expect(recipeAllowsMirror('1.2.4', recipeBuildVersion('1.2.4', revisions), recipeRequiresBuild(revisions, reasons))).toBe(true)
  // Never republishes the superseded identity.
  expect(() => recipeAllowsMirror('1.2.3', recipeBuildVersion('1.2.3', revisions), false, 'elf-loader-paths')).toThrow('refusing to replace')

  expect(revisionAppliesTo('elf-loader-paths', 'linux-x86-64')).toBe(true)
  expect(revisionAppliesTo('elf-loader-paths', 'linux-arm64')).toBe(true)
  expect(revisionAppliesTo('elf-loader-paths', 'darwin-arm64')).toBe(false)
  expect(revisionAppliesTo(undefined, 'darwin-arm64')).toBe(true)
})

test('a Linux-only revision is selected on Linux and leaves macOS on its published base', async () => {
  const { selectRevisionVersions } = await import('../scripts/package-revisions')
  const versions = ['1.2.3.1', '1.2.3', '1.2.2']
  const revisions = { '1.2.3': 1 }
  const reasons = { '1.2.3': 'elf-loader-paths' } as const
  expect(selectRevisionVersions(versions, revisions, reasons, 'linux-x86-64')).toEqual(['1.2.3.1', '1.2.2'])
  expect(selectRevisionVersions(versions, revisions, reasons, 'darwin-arm64')).toEqual(['1.2.3', '1.2.2'])
  // A revision for any other reason applies everywhere.
  expect(selectRevisionVersions(versions, revisions, {}, 'darwin-arm64')).toEqual(['1.2.3.1', '1.2.2'])
  expect(selectRevisionVersions(versions, undefined, undefined, 'darwin-arm64')).toEqual(versions)
})

test('a recipe declaring an ELF loader-path revision loads as mirrorable on Linux', async () => {
  const { recipeIdentity } = await import('../scripts/recipe-loader')
  const identity = recipeIdentity({ revisions: { '1.2.3': 1 }, revisionReasons: { '1.2.3': 'elf-loader-paths' } } as never, '1.2.3.1')
  expect(identity).toEqual({ upstreamVersion: '1.2.3', publicationVersion: '1.2.3.1', requiresRecipeBuild: false, revisionReason: 'elf-loader-paths' })
  const plain = recipeIdentity({ revisions: { '1.2.3': 1 } } as never, '1.2.3.1')
  expect(plain.requiresRecipeBuild).toBe(true)
  expect(plain.revisionReason).toBeUndefined()
})

test('a corrupt published archive is repaired by mirroring the vendor release again, on every platform', async () => {
  const { recipeRequiresBuild, revisionAppliesTo, selectRevisionVersions } = await import('../scripts/package-revisions')
  const revisions = { '1.9.5': 1 }
  const reasons = { '1.9.5': 'corrupt-archive' } as const
  expect(recipeRequiresBuild(revisions, reasons)).toBe(false)
  expect(recipeAllowsMirror('1.9.5.1', recipeBuildVersion('1.9.5.1', revisions), false, 'corrupt-archive')).toBe(true)
  expect(revisionAppliesTo('corrupt-archive', 'darwin-arm64')).toBe(true)
  expect(selectRevisionVersions(['1.9.5.1', '1.9.5'], revisions, reasons, 'darwin-arm64')).toEqual(['1.9.5.1'])
})

test('a prerelease or lettered release takes a .pantryN revision that cannot collide with vendor versions', async () => {
  const { revisionIdentity } = await import('../scripts/package-revisions')
  expect(revisionIdentity('1.5.7', 2)).toBe('1.5.7.2')
  expect(revisionIdentity('3.15.0rc1', 1)).toBe('3.15.0rc1.pantry1')
  expect(revisionIdentity('3.6a', 1)).toBe('3.6a.pantry1')
  const revisions = { '3.15.0rc1': 1 }
  expect(revisedPackageVersions(['3.15.0rc1', '3.14.1'], revisions)).toEqual(['3.15.0rc1.pantry1', '3.14.1'])
  expect(recipeBuildVersion('3.15.0rc1.pantry1', revisions)).toEqual({ upstream: '3.15.0rc1', current: '3.15.0rc1.pantry1' })
  expect(recipeBuildVersion('3.15.0rc1', revisions)).toEqual({ upstream: '3.15.0rc1', current: '3.15.0rc1.pantry1' })
  // rc10 is a different vendor release, not a revision of rc1.
  expect(recipeBuildVersion('3.15.0rc10', revisions)).toEqual({ upstream: '3.15.0rc10', current: '3.15.0rc10' })
  expect(() => recipeBuildVersion('3.15.0rc1.pantry2', revisions)).toThrow('Undeclared package build revision')
  // Numeric and prerelease repairs can sit in one recipe.
  expect(revisedPackageVersions(['3.15.0rc1', '3.14.1'], { '3.15.0rc1': 1, '3.14.1': 1 })).toEqual(['3.15.0rc1.pantry1', '3.14.1.1'])
  expect(() => revisedPackageVersions(['1.0.0+abc'], { '1.0.0+abc': 1 })).toThrow('Invalid package build revision')
  // The vendor ordering puts the revision between its release and the next one.
  const { compareVersions } = await import('../src/generate-zig')
  // (generate-zig's catalog sort: newest first, a revision just ahead of its release.)
  expect(['3.15.0rc1', '3.15.0rc1.pantry1', '3.14.1', '3.14.1.1'].sort(compareVersions)).toEqual(['3.15.0rc1.pantry1', '3.15.0rc1', '3.14.1.1', '3.14.1'])
  expect(['3.6a', '3.6a.pantry2', '3.6a.pantry1'].sort(compareVersions)).toEqual(['3.6a.pantry2', '3.6a.pantry1', '3.6a'])
  expect(compareVersions('3.15.0rc1.pantry1', '3.14.1')).toBeLessThan(0)
})

test('the publish pipeline selects a prerelease loader-path revision on Linux and keeps the base on macOS', async () => {
  const { selectRevisionVersions, recipeAllowsMirror: allows } = await import('../scripts/package-revisions')
  const versions = ['3.15.0', '3.15.0rc1.pantry1', '3.15.0rc1', '3.14.1']
  const revisions = { '3.15.0rc1': 1 }
  const reasons = { '3.15.0rc1': 'elf-loader-paths' } as const
  expect(selectRevisionVersions(versions, revisions, reasons, 'linux-arm64')).toEqual(['3.15.0', '3.15.0rc1.pantry1', '3.14.1'])
  expect(selectRevisionVersions(versions, revisions, reasons, 'darwin-arm64')).toEqual(['3.15.0', '3.15.0rc1', '3.14.1'])
  // It mirrors pkgx's v3.15.0rc1 and publishes it as 3.15.0rc1.pantry1.
  expect(allows('3.15.0rc1.pantry1', recipeBuildVersion('3.15.0rc1.pantry1', revisions), false, 'elf-loader-paths')).toBe(true)
  expect(recipeBuildVersion('3.15.0rc1.pantry1', revisions).upstream).toBe('3.15.0rc1')
})

test('an in-place repair rebuilds the upstream release under its own version, and nothing else', () => {
  const revisions = { '1.5.7': 2 }
  const base = recipeBuildVersion('1.5.7', revisions)
  // Without the switch the base identity is superseded and refused.
  expect(() => requireCurrentRecipeBuild('1.5.7', base.current, base.upstream, false)).toThrow('refusing to replace')
  expect(() => requireCurrentRecipeBuild('1.5.7', base.current, base.upstream, true)).not.toThrow()
  // An older revision is never an in-place target: only the upstream release is.
  const older = recipeBuildVersion('1.5.7.1', revisions)
  expect(() => requireCurrentRecipeBuild('1.5.7.1', older.current, older.upstream, true)).toThrow('refusing to replace')
})

test('PANTRY_REPAIR_IN_PLACE turns the in-place repair on', async () => {
  const { repairInPlace } = await import('../scripts/package-revisions')
  expect(repairInPlace({ PANTRY_REPAIR_IN_PLACE: '1' })).toBe(true)
  expect(repairInPlace({})).toBe(false)
})

test('a short numeric release is revised as .pantryN, never as its vendor next patch release', async () => {
  const { assertNoCollidingRevisionIdentities, numericRevisionCannotCollide } = await import('../scripts/package-revisions')
  expect(revisionIdentity('4.10', 1)).toBe('4.10.pantry1')
  expect(revisionIdentity('18.6', 2)).toBe('18.6.pantry2')
  expect(revisionIdentity('1.5.7', 2)).toBe('1.5.7.2')
  expect(revisionIdentity('5.2.1.2', 1)).toBe('5.2.1.2.1')
  expect(numericRevisionCannotCollide('4.10')).toBe(false)
  expect(numericRevisionCannotCollide('1.5.7')).toBe(true)
  // The vendor's 4.10.1 stays a vendor release beside a revision of 4.10.
  expect(recipeBuildVersion('4.10.1', { '4.10': 1 })).toEqual({ upstream: '4.10.1', current: '4.10.1' })
  expect(recipeBuildVersion('4.10.pantry1', { '4.10': 1 })).toEqual({ upstream: '4.10', current: '4.10.pantry1' })
  expect(revisedPackageVersions(['4.11', '4.10.1', '4.10'], { '4.10': 1 })).toEqual(['4.11', '4.10.1', '4.10.pantry1'])
  // A version list that still carries the old spelling is refused.
  expect(() => assertNoCollidingRevisionIdentities('gnu.org/sed', ['4.10.1', '4.10'], { '4.10': 1 })).toThrow('4.10.pantry1')
  expect(() => assertNoCollidingRevisionIdentities('facebook.com/zstd', ['1.5.7.2', '1.5.7'], { '1.5.7': 2 })).not.toThrow()
})
