import { discoverRecipes } from './check-desktop-updates'

/** Rolling desktop downloads belong to the vendor-version planner, not historical backfills. */
export function publicationOwners(selectors: readonly string[], desktopDomains: ReadonlySet<string>): { packages: string[], desktop: string[] } {
  const packages: string[] = []
  const desktop: string[] = []
  for (const selector of new Set(selectors)) {
    // An explicit version is a deliberate reproduction request. Preserve it exactly.
    if (!selector.includes('@') && desktopDomains.has(selector)) desktop.push(selector)
    else packages.push(selector)
  }
  return { packages: packages.sort(), desktop: desktop.sort() }
}

if (import.meta.main) {
  const domains = new Set((await discoverRecipes()).map(({ recipe }) => recipe.domain))
  const owners = publicationOwners(process.argv.slice(2).flatMap(value => value.split(/[\s,]+/)).filter(Boolean), domains)
  console.log(`domains=${owners.packages.join(' ')}`)
  console.log(`desktop=${owners.desktop.join(' ')}`)
}
