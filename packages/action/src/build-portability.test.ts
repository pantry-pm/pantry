import { describe, expect, test } from 'bun:test'
import { assertPortableActionBundle, makeCrc64SourcePortable } from './build-portability'

describe('GitHub Action build portability', () => {
  test('rewrites Azure CRC64 module URLs to the runtime bundle location', () => {
    const source = 'import { fileURLToPath } from "node:url"; const require = createRequire(import.meta.url); const dir = fileURLToPath(import.meta.url)'
    const portable = makeCrc64SourcePortable(source)
    expect(portable).not.toContain('import.meta.url')
    expect(portable.match(/pathToFileURL\(process\.argv\[1\]\)/g)).toHaveLength(2)
  })

  test('rejects host paths and platform-specific file URLs', () => {
    expect(() => assertPortableActionBundle('const ok = true', '/workspace/pantry')).not.toThrow()
    expect(() => assertPortableActionBundle('const p = "file:///workspace/pantry/node_modules"', '/workspace/pantry')).toThrow('build-host file URL')
    expect(() => assertPortableActionBundle('const p = "file:///Users/chris/repo"', '/workspace/pantry')).toThrow('macOS build-time file URL')
    expect(() => assertPortableActionBundle('const p = "file:///D:/a/repo"', '/workspace/pantry')).toThrow('Windows build-time file URL')
  })
})
