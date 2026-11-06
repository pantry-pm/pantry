import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

for (const changed of [false, true]) {
  test(`desktop manifest landing is gated on a real new commit (changed=${changed})`, async () => {
    const workflow = Bun.YAML.parse(await readFile(new URL('../../../.github/workflows/check-desktop-updates.yml', import.meta.url), 'utf8')) as any
    const steps = workflow.jobs.record.steps
    const checkout = steps.find((step: any) => step.uses?.startsWith('actions/checkout'))
    expect(checkout.with['fetch-depth']).toBe(0)
    expect(steps.find((step: any) => step.name === 'Land the verified manifest once CI passes').if).toBe("steps.manifest.outputs.committed == 'true'")
    const root = await mkdtemp(join(tmpdir(), 'pantry-desktop-gate-'))
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    try {
      await mkdir(join(root, 'packages/ts-pantry'), { recursive: true })
      await mkdir(join(root, 'bin'))
      await writeFile(join(root, 'manifest.json'), '{}\n')
      git('init', '-b', 'main')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.com')
      git('add', '.')
      git('commit', '-m', 'baseline')
      const before = git('rev-parse', 'HEAD')
      await writeFile(join(root, 'bin/bun'), `#!/bin/sh\n${changed ? "printf 'updated\\n' > ../../manifest.json\ngit add ../../manifest.json\ngit commit -m 'verified manifest'" : 'exit 0'}\n`, { mode: 0o755 })
      const output = join(root, 'output')
      await writeFile(output, '')
      const result = Bun.spawnSync(['bash', '-e', '-c', steps.find((step: any) => step.id === 'manifest').run], {
        cwd: root, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, GITHUB_OUTPUT: output }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      expect((await readFile(output, 'utf8')).includes('committed=true')).toBe(changed)
      expect(git('rev-parse', 'HEAD') !== before).toBe(changed)
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })
}
