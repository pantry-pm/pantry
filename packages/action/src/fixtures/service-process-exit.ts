import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { mock } from 'bun:test'

// The OS boundary is simulated in this child only. Other files retain their
// real platform/filesystem and the existing live-process ownership tests.
const originalRead = fs.readFileSync
const originalStat = fs.statSync
const phase = process.argv[2]!
const pid = 42424242
const directory = `/proc/${pid}`
const fields = ['S', '1', String(pid), ...Array.from({ length: 16 }, () => '0'), '12345']
const stat = `${pid} (owned native service) ${fields.join(' ')}`
let reads = 0
const gone = (code = 'ESRCH') => Object.assign(new Error(`${code}: simulated process read`), { code })
mock.module('node:fs', () => ({
  ...fs,
  readFileSync: (path: fs.PathOrFileDescriptor, options?: any) => {
    if (path === `${directory}/stat`) {
      reads++
      if (phase === 'before' || (phase === 'after' && reads === 2)) throw gone()
      if (phase === 'missing') throw gone('ENOENT')
      if (phase === 'permission') throw gone('EACCES')
      return stat
    }
    if (path === `${directory}/cmdline`) {
      if (phase === 'command') throw gone()
      return '/usr/local/bin/owned-service\0--data-dir\0/private/owned-service'
    }
    return originalRead(path, options)
  },
  statSync: (path: fs.PathLike, options?: any) => path === directory ? { uid: process.getuid!() } : originalStat(path, options),
}))
Object.defineProperty(process, 'platform', { value: 'linux' })
const { serviceProcessIdentity } = await import('../service-ownership')
if (phase === 'permission') await assert.rejects(() => serviceProcessIdentity(pid), { code: 'EACCES' })
else assert.equal(await serviceProcessIdentity(pid), undefined, 'a process lost during identity inspection is already gone')
process.stdout.write('service exit observation OK\n')
