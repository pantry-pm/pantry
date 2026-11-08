import { expect, test } from 'bun:test'
import { discoverRecipes } from './check-desktop-updates'
import { publicationOwners } from './publication-owners'

test('desktop apps and fonts use their vendor planner while terminal packages keep native backfills', async () => {
  const domains = new Set((await discoverRecipes()).map(({ recipe }) => recipe.domain))
  expect(publicationOwners(['claude.ai', 'anthropic.com/claude-code', 'whatsapp.com', 'brave.com', 'gnu.org/readline'], domains)).toEqual({
    desktop: ['brave.com', 'claude.ai', 'whatsapp.com'], packages: ['anthropic.com/claude-code', 'gnu.org/readline'],
  })
  for (const domain of domains) expect(publicationOwners([domain], domains)).toEqual({ packages: [], desktop: [domain] })
})

test('explicit version reproduction is never broadened to the current desktop version', () => {
  expect(publicationOwners(['claude.ai@4.23118.0', 'claude.ai', 'claude.ai', 'bun.com@1.4.4'], new Set(['claude.ai']))).toEqual({
    packages: ['bun.com@1.4.4', 'claude.ai@4.23118.0'], desktop: ['claude.ai'],
  })
  expect(publicationOwners([], new Set())).toEqual({ packages: [], desktop: [] })
})
