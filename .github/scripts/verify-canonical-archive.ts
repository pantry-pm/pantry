import assert from 'node:assert/strict'
import { archiveMembers } from './published-archive'

const candidate = process.argv[2]
const publicArchive = process.argv[3]
assert(candidate && publicArchive, 'Supply the original canonical candidate and public archive')
const [candidateBytes, publicBytes] = await Promise.all([Bun.file(candidate).bytes(), Bun.file(publicArchive).bytes()])
const expected = archiveMembers(candidateBytes)
const actual = archiveMembers(publicBytes)
assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), 'Public archive member names differ from the canonical candidate')
for (const [path, member] of expected)
  assert.deepEqual(actual.get(path), member, `Public archive bytes, mode, type or link changed: ${path}`)
console.log(JSON.stringify({ passed: true, candidate, publicArchive, members: expected.size }))
