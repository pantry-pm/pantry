import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recipe } from '../src/recipes/apps/claude.ai'
import { claudeReleaseFeed, fetchClaudeReleases, parseClaudeReleases } from '../src/recipes/props/claude.ai/releases'
import { verifyClaudeBundle } from '../src/recipes/props/claude.ai/verify'
import { bundledPackageCatalog, createPackageCatalogSearch } from '../src/catalog/client'
import { aliases } from '../src/packages/aliases'

const version = '4.23118.0'
const url = `https://downloads.claude.ai/releases/darwin/universal/${version}/Claude-${'a'.repeat(40)}.zip`
const release = { version, updateTo: { version, url } }
const feed = { currentRelease: version, releases: [release] }

test('Claude desktop discovery uses the official current release and exact versioned archive', async () => {
  expect(parseClaudeReleases(feed)).toEqual([{ version, url }])
  expect(await fetchClaudeReleases(async (input, init) => {
    expect(input).toBe(claudeReleaseFeed)
    expect(init?.redirect).toBe('error')
    return Response.json(feed)
  })).toEqual([{ version, url }])
  await expect(fetchClaudeReleases(async () => new Response('', { status: 503 }))).rejects.toThrow('503')
  const older = { version: '4.0.0', updateTo: { version: '4.0.0', url: url.replaceAll(version, '4.0.0') } }
  expect(parseClaudeReleases({ ...feed, releases: [older, release] }).map(item => item.version)).toEqual([version, '4.0.0'])
})

test('Claude feed rejects missing current release, wrong hosts, mismatched versions and ambiguous archives', () => {
  for (const invalid of [null, {}, { ...feed, releases: [] }, { ...feed, currentRelease: '4.0.0' },
    ...['http://downloads.claude.ai/releases/darwin/universal/', 'https://downloads.claude.ai.evil.example/releases/darwin/universal/', 'https://user:secret@downloads.claude.ai/releases/darwin/universal/'].map(prefix => ({ ...feed, releases: [{ ...release, updateTo: { version, url: url.replace('https://downloads.claude.ai/releases/darwin/universal/', prefix) } }] })),
    { ...feed, releases: [{ ...release, updateTo: { version: '4.0.0', url } }] },
    { ...feed, releases: [{ ...release, updateTo: { version, url: url.replace(version, '4.0.0') } }] },
    { ...feed, releases: [release, { ...release, updateTo: { version, url: url.replace('a'.repeat(40), 'b'.repeat(40)) } }] },
  ]) expect(() => parseClaudeReleases(invalid)).toThrow()
})

test('Claude is a signed native app with separate desktop aliases and no terminal command collision', () => {
  expect(recipe.programs).toEqual([])
  expect(recipe.platforms).toEqual(['darwin/aarch64'])
  expect(recipe.build.skip).toContain('fix-machos')
  expect(recipe.test?.required).toBe(true)
  for (const alias of ['claude-desktop', 'claude-code-desktop', 'claude-app']) expect(aliases[alias]).toBe('claude.ai')
  expect(aliases['claude-code']).toBe('anthropic.com/claude-code')
  const catalog = bundledPackageCatalog()
  const desktop = catalog.find(entry => entry.domain === 'claude.ai')
  expect(desktop?.kind).toBe('app')
  expect(desktop?.name).toBe('Claude') // Match CFBundleName so native app discovery recognizes the installed bundle.
  expect(desktop?.programs).toEqual([])
  expect(typeof desktop?.latestVersion).toBe('string')
  expect(createPackageCatalogSearch(catalog)('claude-code-desktop')[0]?.domain).toBe('claude.ai')
})

test('bundle verification fails before publication for the wrong identity, version or missing executable', async () => {
  const app = mkdtempSync(join(tmpdir(), 'claude-bundle-'))
  mkdirSync(join(app, 'Contents'))
  const plist = (id: string, v: string) => `<plist><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${v}</string><key>CFBundleExecutable</key><string>Claude</string></dict></plist>`
  try {
    for (const [id, v] of [['wrong.app', version], ['com.anthropic.claudefordesktop', '4.0.0']]) {
      writeFileSync(join(app, 'Contents/Info.plist'), plist(id!, v!))
      await expect(verifyClaudeBundle(app, version)).rejects.toThrow('identity or version')
    }
    writeFileSync(join(app, 'Contents/Info.plist'), plist('com.anthropic.claudefordesktop', version))
    await expect(verifyClaudeBundle(app, version)).rejects.toThrow()
  }
  finally { rmSync(app, { recursive: true, force: true }) }
})
