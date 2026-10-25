import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bumpx's normal post-version command: build and stage only tracked outputs. */
export function buildReleaseAction(cwd: string = process.cwd()): void {
  const workflows = ['.github/workflows/native-app.yml', '.github/workflows/native-check.yml']
  const outputs = ['packages/action/dist/index.js', 'packages/action/dist/post.js', ...workflows]
  const run = (args: string[]) => {
    const result = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 })
    assert.equal(result.exitCode, 0, Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString())
  }
  run(['git', 'ls-files', '--error-unmatch', '--', ...outputs])
  const version = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version
  for (const file of workflows) {
    const workflow = join(cwd, file)
    writeFileSync(workflow, readFileSync(workflow, 'utf8').replace(/(uses: pantry-pm\/pantry\/packages\/action@)v[\d.]+/g, `$1v${version}`))
  }
  run(['bun', 'run', '--cwd', 'packages/action', 'build'])
  run(['git', 'add', '--', ...outputs])
}

if (import.meta.main) buildReleaseAction()
