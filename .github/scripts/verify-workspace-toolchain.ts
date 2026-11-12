import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const manifest = Bun.JSONC.parse(readFileSync(new URL('../../pantry.jsonc', import.meta.url), 'utf8'))
assert(manifest && typeof manifest === 'object' && 'dependencies' in manifest, 'Workspace dependencies are required')
const dependencies = manifest.dependencies
assert(dependencies && typeof dependencies === 'object' && 'bun.sh' in dependencies && 'ziglang.org' in dependencies, 'The workspace must declare both tools')
const expectedBun = dependencies['bun.sh']
const expectedZig = dependencies['ziglang.org']
assert(typeof expectedBun === 'string', 'The workspace must declare its Bun runtime')
assert(typeof expectedZig === 'string', 'The workspace must declare its Zig compiler')
assert.equal(Bun.version, expectedBun, 'The active Bun runtime must satisfy the declared workspace pin')
const zig = Bun.which('zig')
assert(zig, 'The declared Zig compiler must be activated through Pantry')
const result = Bun.spawnSync([zig, 'version'], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 })
assert.equal(result.exitCode, 0, result.stderr.toString())
console.log(JSON.stringify({ bun: Bun.version, zig: result.stdout.toString().trim(), executable: zig, resolvedExecutable: realpathSync(zig) }))
assert.equal(result.stdout.toString().trim(), expectedZig, 'A later tool install must preserve the workspace compiler pin')

// A declared SHA is a build input, not a label. Published bootstrap installers
// predating #330 silently cloned default HEAD and reported the requested SHA.
const gitInputs = []
for (const [name, spec] of Object.entries(dependencies)) {
  if (!spec || typeof spec !== 'object' || !('source' in spec) || spec.source !== 'github') continue
  assert('repo' in spec && typeof spec.repo === 'string')
  assert('version' in spec && typeof spec.version === 'string' && /^[0-9a-f]{40}$/.test(spec.version), `${name} must declare an immutable Git commit`)
  const directory = fileURLToPath(new URL(`../../pantry/${name}`, import.meta.url))
  const git = (args: string[]) => {
    const child = Bun.spawnSync(['git', '-C', directory, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 })
    assert.equal(child.signalCode ?? null, null)
    assert(!child.exitedDueToTimeout)
    assert.equal(child.exitCode, 0, child.stderr.toString())
    return child.stdout.toString().trim()
  }
  const commit = git(['rev-parse', '--verify', 'HEAD^{commit}'])
  assert.equal(commit, spec.version, `${name}: installed Git HEAD must equal its declared build input`)
  assert.equal(git(['config', '--local', '--get', 'remote.origin.url']), `https://github.com/${spec.repo}.git`, `${name}: installed remote must equal its declared source`)
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '', `${name}: tracked build inputs must be unchanged`)
  gitInputs.push({ name, directory, commit })
}
assert(gitInputs.length > 0, 'The workspace Git compiler dependencies must be verified')
console.log(JSON.stringify({ gitInputs }))
