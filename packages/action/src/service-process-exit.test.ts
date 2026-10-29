import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const phase of ['before', 'command', 'after', 'missing', 'permission']) {
  test(`Linux process identity handles ${phase} during an owned service exit`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pantry-service-exit-'))
    try {
      const config = join(directory, 'bunfig.toml')
      writeFileSync(config, 'preload = []\n')
      const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', join(import.meta.dir, 'fixtures/service-process-exit.ts'), phase], { stdout: 'pipe', stderr: 'pipe' })
      const watchdog = setTimeout(() => child.kill(), 10_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        expect(code, `${stdout}\n${stderr}`).toBe(0)
        expect(stdout).toContain('service exit observation OK')
      }
      finally { clearTimeout(watchdog) }
    }
    finally { rmSync(directory, { recursive: true, force: true }) }
  }, 15_000)
}
