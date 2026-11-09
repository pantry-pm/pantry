import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { archiveCachePath, restoreCachedArchive, storeCachedArchive } from '../src/installer'

const dirs: string[] = []
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-archive-cache-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const url = 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip'

describe('release archive cache', () => {
  it('keeps one archive per release URL under the user cache', () => {
    const file = archiveCachePath(url, 'zip', {}, '/home/runner')!
    expect(path.dirname(file)).toBe('/home/runner/.cache/pantry/archives')
    expect(file.endsWith('.zip')).toBe(true)
    expect(archiveCachePath(url.replace('1.4.4', '1.4.3'), 'zip', {}, '/home/runner')).not.toBe(file)
    expect(path.dirname(archiveCachePath(url, 'zip', { XDG_CACHE_HOME: '/x' }, '/home/runner')!)).toBe('/x/pantry/archives')
    expect(path.dirname(archiveCachePath(url, 'zip', { PANTRY_ARCHIVE_CACHE_DIR: '/mnt/a' }, '/home/runner')!)).toBe('/mnt/a')
  })

  it('can be turned off, and guesses no home', () => {
    expect(archiveCachePath(url, 'zip', { PANTRY_ARCHIVE_CACHE: '0' }, '/home/runner')).toBeNull()
    expect(archiveCachePath(url, 'zip', {}, '')).toBeNull()
    expect(archiveCachePath('http://127.0.0.1:4100/bun.zip', 'zip', {}, '/home/runner')).toBeNull()
  })

  it('stores an archive and restores the same bytes', () => {
    const dir = temp()
    const archive = path.join(dir, 'archive.zip')
    fs.writeFileSync(archive, 'release bytes')
    const cached = path.join(dir, 'cache', 'a.zip')
    storeCachedArchive(archive, cached)
    const dest = path.join(dir, 'restored.zip')
    expect(restoreCachedArchive(cached, dest)).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe('release bytes')
    expect(fs.readdirSync(path.dirname(cached))).toEqual(['a.zip'])
  })

  it('discards a cached archive that no longer matches the published digest', () => {
    const dir = temp()
    const cached = path.join(dir, 'a.zip')
    fs.writeFileSync(cached, 'tampered')
    const good = createHash('sha256').update('release bytes').digest('hex')
    expect(restoreCachedArchive(cached, path.join(dir, 'dest.zip'), good)).toBe(false)
    expect(fs.existsSync(cached)).toBe(false)
    fs.writeFileSync(cached, 'release bytes')
    expect(restoreCachedArchive(cached, path.join(dir, 'dest.zip'), good.toUpperCase())).toBe(true)
  })

  it('a missing cache entry is simply a miss', () => {
    const dir = temp()
    expect(restoreCachedArchive(path.join(dir, 'none.zip'), path.join(dir, 'dest.zip'))).toBe(false)
  })
})
