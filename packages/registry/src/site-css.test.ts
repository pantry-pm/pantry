import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderTemplate } from '@stacksjs/stx'

/**
 * The site's utility CSS is injected at render time by stx scanning the
 * templates (`injectCSS: true`) and loading `@cwcss/crosswind`. That import
 * lives inside a try/catch in stx, so a crosswind release whose package
 * exports do not resolve does not throw — it returns no CSS. The page still
 * renders, with a 200, and every utility class silently does nothing: the
 * header stacks into a column, the max-width container disappears, the layout
 * collapses. 0.2.0 and 0.2.1 shipped exactly that (an exports map pointing at
 * ./dist/index.js while the tarball put the JS at ./dist/src/index.js).
 *
 * CLAUDE.md documents a manual command to check this before bumping the
 * dependency. Nothing ran it, and buddy-bot opens dependency bumps on its own,
 * so the one guard against a silently broken site was somebody remembering.
 * This is that command, as a test.
 *
 * Confirmed to actually fail: with the crosswind entry point removed from BOTH
 * trees it resolves through (node_modules and pantry/), the page still renders
 * a complete 200 with every meta tag and font face in place, and the `.flex`
 * assertion below is what catches it. Breaking only one tree is not enough —
 * stx falls back to the other, which is its own finding.
 *
 * Known blind spot, stated so nobody trusts this further than it goes: on any
 * machine where BOTH trees exist (CI, after the Setup Pantry action, and a dev
 * checkout) a broken node_modules copy is masked by the pantry/ one and this
 * test still passes. Production is not exposed to that — the deploy runs
 * `bun install` and never `pantry install`, so the box carries only the pinned
 * node_modules tree — but a green run here is not by itself proof that the
 * pinned version specifically is sound.
 */
const SITE = resolve(import.meta.dir, '..', 'site')
const PAGE = resolve(SITE, 'pages', 'about.stx')

describe('site utility CSS', () => {
  it.skipIf(!existsSync(PAGE))('is injected by crosswind at render time', async () => {
    const html = await renderTemplate(PAGE, {
      layout: resolve(SITE, 'pages', 'layout.stx'),
      options: { componentsDir: resolve(SITE, 'components') },
      injectCSS: true,
      wrapInDocument: false,
    })

    // A handful of utilities the layout genuinely depends on. Asserting on
    // several rather than one means a partial engine failure — crosswind
    // loading but producing nothing for a whole category — cannot pass.
    expect(html).toMatch(/\.flex\s*\{/)
    expect(html).toMatch(/\.items-center\s*\{/)
    expect(html).toMatch(/\.mx-auto\s*\{/)
    // A collapsed page is small; a rendered one is tens of KB. Cheap backstop
    // against the template resolving to almost nothing.
    expect(html.length).toBeGreaterThan(10_000)
  })
})
