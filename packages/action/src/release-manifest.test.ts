import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createReleaseManifest } from './release-manifest'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

describe('createReleaseManifest', () => {
  test('records deterministic artifact metadata', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-release-manifest-'))
    directories.push(directory)
    const artifact = path.join(directory, 'app.pkg')
    fs.writeFileSync(artifact, 'signed package')

    expect(createReleaseManifest({
      repository: 'stacksjs/stacks',
      tag: 'v1.2.3',
      commit: 'abc123',
      generatedAt: '2026-07-28T00:00:00.000Z',
      files: [artifact],
    })).toEqual({
      schemaVersion: 1,
      repository: 'stacksjs/stacks',
      tag: 'v1.2.3',
      commit: 'abc123',
      generatedAt: '2026-07-28T00:00:00.000Z',
      assets: [{
        name: 'app.pkg',
        size: 14,
        sha256: 'be1e9dff7f485a8e49b0fb61a1b67c5290f54d6441b45ed6546afe5338ac9aff',
      }],
    })
  })
})
