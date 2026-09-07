import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEBUG_DUMP_END, DEBUG_DUMP_START } from './build-all-packages'

const buildPackage = readFileSync(join(import.meta.dir, 'build-package.ts'), 'utf8')

describe('failure context skips build-package.ts debug dumps', () => {
  // build-package.ts prints the generated script and config.log AFTER the real
  // error, to help a human reading the job log. The failure context we attach
  // to the error has to step over them, or every failure reports the recipe's
  // own source instead of what went wrong — which is exactly what the first
  // version did for ghostscript, poppler, llrt and postgrest.
  test('every start marker is still printed by build-package.ts', () => {
    for (const marker of DEBUG_DUMP_START)
      expect(buildPackage).toContain(marker)
  })

  test('every end marker is still printed by build-package.ts', () => {
    for (const marker of DEBUG_DUMP_END)
      expect(buildPackage).toContain(marker)
  })

  test('each dump is bounded — no start marker is left without an end', () => {
    // A start with no matching end would swallow the rest of the output and
    // leave the failure context empty, which is worse than the wrong context.
    expect(DEBUG_DUMP_END.length).toBeGreaterThanOrEqual(DEBUG_DUMP_START.length)
  })
})
