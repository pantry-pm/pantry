// How the SDK unpacks a downloaded zip, and what it says when an archive held
// nothing usable.
//
// Windows used to extract with `powershell -Command Expand-Archive ...`. That
// cmdlet is resolved through PSModulePath, which a pwsh 7 parent fills with its
// own modules; once a runner image shipped one that Windows PowerShell cannot
// run, extraction printed an exception, exited 0 and wrote nothing, and a fresh
// Bun install failed as "unpacked without its required primary executable
// bun.exe" with no hint of why. The Windows half of this is proven on a real
// host by .github/scripts/windows-native-runtime.ts; these tests pin the
// platform-independent contract.

import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeDirectory, extractArchive, windowsSystemTar } from '../src/installer'

const scratch: string[] = []
afterAll(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** A stored (uncompressed) zip, written by hand so the fixture needs no zip tool. */
function zip(entries: Record<string, string | null>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, contents] of Object.entries(entries)) {
    const data = Buffer.from(contents ?? '')
    const nameBytes = Buffer.from(name)
    const crc = Bun.hash.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x21, 12) // 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(contents === null ? 0x10 : 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

test('the Windows extractor is the tar that ships in System32, not whichever tar PATH finds first', () => {
  expect(windowsSystemTar({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\tar.exe')
  expect(windowsSystemTar({ windir: 'E:\\Windows' })).toBe('E:\\Windows\\System32\\tar.exe')
  expect(windowsSystemTar({})).toBe('C:\\Windows\\System32\\tar.exe')
})

test('a zip unpacks its top-level folder into a path a shell would have split or expanded', async () => {
  // Spaces, quotes and PowerShell's expansion characters: the extractor must
  // receive these paths as literal argv entries, never as script text.
  const root = temp('pantry zip $(literal) \'quoted\' [1]; ')
  const archive = join(root, 'bun windows $env:x.zip')
  writeFileSync(archive, zip({ 'bun-windows-x64/': null, 'bun-windows-x64/bun.exe': 'MZ fixture executable' }))
  const destination = join(root, 'extracted; $(x) @(y) `z`')
  mkdirSync(destination)

  await extractArchive(archive, destination, 'zip')

  expect(readFileSync(join(destination, 'bun-windows-x64', 'bun.exe'), 'utf8')).toBe('MZ fixture executable')
})

test('a zip that cannot be read fails extraction instead of leaving an empty directory', async () => {
  const root = temp('pantry-zip-corrupt-')
  const archive = join(root, 'archive.zip')
  writeFileSync(archive, 'not a zip archive')
  const destination = join(root, 'extracted')
  mkdirSync(destination)

  await expect(extractArchive(archive, destination, 'zip')).rejects.toThrow()
})

test('an install failure lists what the unpacked directory actually held', () => {
  const root = temp('pantry-describe-')
  expect(describeDirectory(root)).toBe('(empty)')

  mkdirSync(join(root, 'bun-windows-x64', 'nested'), { recursive: true })
  writeFileSync(join(root, 'bun-windows-x64', 'bun'), 'abc')
  writeFileSync(join(root, 'bun-windows-x64', 'empty.exe'), '')
  expect(describeDirectory(root)).toBe([
    'bun-windows-x64/',
    '  bun (3 bytes)',
    '  empty.exe (0 bytes)',
    '  nested/',
  ].join('\n'))

  for (let index = 0; index < 5; index++) writeFileSync(join(root, `file-${index}`), 'x')
  expect(describeDirectory(root, { maxEntries: 3 })).toBe([
    'bun-windows-x64/',
    '  bun (3 bytes)',
    '  empty.exe (0 bytes)',
    '... 6 more entries',
  ].join('\n'))
  expect(describeDirectory(join(root, 'missing'))).toMatch(/^<unreadable: ENOENT>$/)
})
