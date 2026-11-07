import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
assert.equal(result.stdout.toString().trim(), expectedZig, 'A later tool install must preserve the workspace compiler pin')
console.log(JSON.stringify({ bun: Bun.version, zig: result.stdout.toString().trim(), executable: zig }))
