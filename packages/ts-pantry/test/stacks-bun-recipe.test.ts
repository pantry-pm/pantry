// stacksjs.com/bun: Bun as stacksjs/bun builds it.
//
// Its versions are not the tags. A release is tagged `bun-v1.4.4-stacks.1`, the
// catalog and every published artifact say `1.4.4.1`, and the build is handed
// only the second. Both directions are in the recipe, so both are checked here:
// a tag the pattern drops is a release that is never published, and a version
// that does not come back as its tag is a download that 404s.

import { describe, expect, it } from 'bun:test'
import { mergeRecipeVersions } from '../../../.github/scripts/register-native-ci-packages'
import { generateBuildScript } from '../scripts/buildkit'
import { loadRecipe } from '../scripts/recipe-loader'
import { pantry } from '../src/packages'
import { aliases } from '../src/packages/aliases'
import { recipe, releaseTagPattern } from '../src/recipes/stacksjs.com/bun'

const script = recipe.build.script.join('\n')

/** What version-fetcher.ts makes of a tag: the capture groups, joined by dots. */
function versionOf(tag: string): string | undefined {
  const match = tag.match(releaseTagPattern)
  return match ? match.slice(1).filter(Boolean).join('.') : undefined
}

describe('stacksjs.com/bun is registered beside bun.com, not in its place', () => {
  const pkg = Object.values(pantry).find(each => each.domain === recipe.domain)

  it('has its own domain and name', () => {
    expect(pkg?.name).toBe('stacks-bun')
    expect(aliases['stacks-bun']).toBe('stacksjs.com/bun')
    expect(pkg?.programs).toEqual(['bun', 'bunx'])
  })

  it('leaves `bun` meaning the official runtime', () => {
    expect(aliases.bun).toBe('bun.com')
    expect(aliases['bun.sh']).toBe('bun.com')
  })

  it('lists only versions a registration accepts', () => {
    expect(pkg?.versions.length).toBeGreaterThan(0)
    expect(() => mergeRecipeVersions([], [...pkg!.versions])).not.toThrow()
  })
})

describe('a release tag and its version', () => {
  it('turns a tag into a numeric version', () => {
    expect(versionOf('bun-v1.4.4-stacks.1')).toBe('1.4.4.1')
    expect(versionOf('bun-v1.5.0-stacks.12')).toBe('1.5.0.12')
  })

  it('takes nothing that is not one of our releases', () => {
    for (const tag of ['bun-v1.4.4', 'v1.4.4-stacks.1', 'bun-v1.4-stacks.1', 'bun-v1.4.4-stacks.', 'bun-v1.4.4-stacks.1-rc', 'bun-v1.4.4-canary.1'])
      expect(versionOf(tag)).toBeUndefined()
  })

  it('gets the tag back from the version, in the shell the build runs', () => {
    const lines = recipe.build.script.filter((line): line is string => typeof line === 'string')
    const derive = lines.slice(lines.indexOf('VERSION="{{version}}"'), lines.findIndex(line => line.startsWith('TAG=')) + 1)
    expect(derive).toHaveLength(4)
    for (const tag of ['bun-v1.4.4-stacks.1', 'bun-v1.5.0-stacks.12', 'bun-v2.0.10-stacks.3']) {
      const run = Bun.spawnSync(['bash', '-euc', `${derive.join('\n').replace('{{version}}', versionOf(tag)!)}\nprintf '%s %s' "$TAG" "$OFFICIAL"`])
      expect(run.stdout.toString()).toBe(`${tag} ${tag.slice('bun-v'.length, tag.indexOf('-stacks'))}`)
    }
  })
})

describe('stacksjs.com/bun build script', () => {
  it('uses no shell variable it does not assign', () => {
    const referenced = [...script.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g)].map(match => match[1])
    const assigned = new Set([...script.matchAll(/(?:^|[\s;)])([A-Z_][A-Z0-9_]*)=/gm)].map(match => match[1]))
    for (const name of referenced)
      expect({ name, assigned: assigned.has(name) }).toEqual({ name, assigned: true })
  })

  it('has an asset for every platform it claims, and claims no other', () => {
    expect(recipe.platforms).toEqual(['darwin/aarch64', 'linux/x86-64'])
    for (const platform of recipe.platforms!)
      expect(script).toContain(`${platform.replace('/', '+')})`)
    expect(script.match(/^ {2}\w+\+[\w-]+\)/gm)).toHaveLength(recipe.platforms!.length)
  })

  it('checks the download against the release checksums before installing', () => {
    expect(script.indexOf('sha256sum --check')).toBeGreaterThan(script.indexOf('SHASUMS256.txt'))
    expect(script.indexOf('install -Dm755')).toBeGreaterThan(script.indexOf('sha256sum --check'))
  })

  it('downloads from stacksjs/bun under the derived tag', async () => {
    const loaded = await loadRecipe('stacksjs.com/bun', 'linux-x86-64', '1.4.4.1')
    const generated = generateBuildScript(loaded.recipe, 'stacksjs.com/bun', '1.4.4.1', 'linux-x86-64', '/prefix', '/build', {})
    expect(generated).toContain('VERSION="1.4.4.1"')
    expect(generated).toContain('https://github.com/stacksjs/bun/releases/download/${TAG}')
    expect(generated).toContain('linux+x86-64 in')
    expect(generated).not.toContain('{{')
  })

  it('fails the build on a binary without the calls it is published for', () => {
    expect(recipe.test?.required).toBe(true)
    const health = recipe.test!.script.join('\n')
    for (const call of ['sql.reserveSync', 'query.wait', 'query.executeSync', 'query.cancelSync'])
      expect(health).toContain(call)
  })
})
