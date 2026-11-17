import { describe, expect, it } from 'bun:test'
import { recipe } from '../src/recipes/qemu.org'

describe('qemu recipe', () => {
  it('builds from source instead of mirroring pkgx binaries linked to a different ncurses ABI', async () => {
    // pkgx's prebuilt qemu binds COLS, LINES and the wide curses API to pkgx's
    // single libncurses. Pantry publishes separate narrow and wide libraries
    // with terminfo split out, so a mirrored qemu bundled with Pantry's ncurses
    // aborted at launch: "Symbol not found: _COLS ... Expected in libncurses".
    const source = await Bun.file(new URL('../scripts/build-all-packages.ts', import.meta.url).pathname).text()
    const customBuilds = source.slice(source.indexOf('const CUSTOM_BUILD_DOMAINS'), source.indexOf('// Map our platform string'))
    expect(customBuilds).toContain(`'qemu.org'`)
  })

  it('uses a capstone whose published headers satisfy qemu\'s <capstone.h> probe', () => {
    expect(recipe.dependencies?.['capstone-engine.org']).toBe('^5')
  })

  it('links the curses UI against the declared Pantry ncurses', () => {
    expect(recipe.dependencies?.['invisible-island.net/ncurses']).toBe('^6')
    const args = (recipe.build?.env as Record<string, unknown>)?.ARGS as string[]
    expect(args).toContain('--enable-curses')
    expect(args).toContain('--extra-cflags=-DNCURSES_WIDECHAR=1')
  })
})
