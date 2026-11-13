import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { macOSMinimumVersions, verifyMacOSDeploymentTarget } from '../scripts/macos-deployment-target'
import { generateBuildScript, platformReduce } from '../scripts/buildkit'
import { loadRecipe } from '../scripts/recipe-loader'

const modern = (minimum: string, platform = '1'): string => `Load command 1
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform ${platform}
    minos ${minimum}
      sdk 27.0
   ntools 1
`
const legacy = (minimum: string): string => `Load command 1
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version ${minimum}
      sdk 27.0
`

for (const [domain, upstream, publication] of [
  ['gnu.org/libiconv', '1.19.0', '1.19.0.2'],
  ['github.com/google/brotli', '1.2.0', '1.2.0.1'],
  ['tukaani.org/xz', '5.8.2', '5.8.2.1'],
]) {
  test(`${domain} publishes a portable source revision with required real consumers`, async () => {
    const loaded = await loadRecipe(domain, 'darwin-arm64', upstream)
    expect(loaded.upstreamVersion).toBe(upstream)
    expect(loaded.publicationVersion).toBe(publication)
    expect(loaded.requiresRecipeBuild).toBe(true)
    expect(loaded.recipe.test?.required).toBe(true)
    const env = loaded.recipe.build!.env ?? {}
    expect(platformReduce(env, 'darwin-arm64').MACOSX_DEPLOYMENT_TARGET).toBe('14.0')
    expect(platformReduce(env, 'linux-arm64').MACOSX_DEPLOYMENT_TARGET).toBeUndefined()
    const script = generateBuildScript(loaded.recipe, domain, upstream, 'darwin-arm64', `/package/v${publication}`, '/source', {})
    expect(script).toContain('export MACOSX_DEPLOYMENT_TARGET="14.0"')
  })
}

test('the revised expat recipe declares its Darwin baseline through the normal recipe loader', async () => {
  const loaded = await loadRecipe('libexpat.github.io', 'darwin-arm64', '2.10.0.1')
  expect(loaded.upstreamVersion).toBe('2.10.0')
  expect(loaded.publicationVersion).toBe('2.10.0.1')
  expect(loaded.requiresRecipeBuild).toBe(true)
  const env = loaded.recipe.build!.env!
  expect(platformReduce(env, 'darwin-arm64').MACOSX_DEPLOYMENT_TARGET).toBe('14.0')
  expect(platformReduce(env, 'linux-arm64').MACOSX_DEPLOYMENT_TARGET).toBeUndefined()
  const script = generateBuildScript(loaded.recipe, 'libexpat.github.io', loaded.upstreamVersion!, 'darwin-arm64', '/package/v2.10.0.1', '/source', {})
  expect(script).toContain('export MACOSX_DEPLOYMENT_TARGET="14.0"')
  expect(script).toContain('./configure --prefix=/package/v2.10.0.1')
})

test('all universal slices are checked; modern and legacy minima are independent of the SDK', () => {
  expect(macOSMinimumVersions(`/image:\n${modern('14.0')}`)).toEqual(['14.0'])
  expect(macOSMinimumVersions(`/image (architecture arm64):\n${modern('14.0')}/image (architecture x86_64):\n${legacy('15.0.1')}`)).toEqual(['14.0', '15.0.1'])
  expect(macOSMinimumVersions(`/image:\n${modern('18.0', '2')}`)).toEqual([])
  expect(macOSMinimumVersions(`/image:\n${modern('14.0', 'MACOS')}`)).toEqual(['14.0'])
  expect(macOSMinimumVersions(`/image:\n${legacy('12.0').replace('MACOSX', 'IPHONEOS')}`)).toEqual([])
})

test('absent or malformed metadata fails qualification instead of assuming host compatibility', () => {
  for (const output of ['', '/image:\n', '/image:\nLoad command 0\n cmd LC_UUID\n', `/image:\n${modern('invalid')}`, `/image:\n${modern('14.0', 'unknown')}`, `/image:\n${modern('14.0', '99')}`, `/image:\n${modern('14.0').replace('minos', 'sdk')}`, `/image (architecture arm64):\n${modern('14.0')}/image (architecture x86_64):\nLoad command 0\n cmd LC_UUID\n`])
    expect(() => macOSMinimumVersions(output)).toThrow()
})

test('the prefix walk checks real runtime files, skips static files and symlinks, and rejects a newer slice', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-macos-target-'))
  try {
    mkdirSync(join(root, 'lib'))
    const runtime = Buffer.alloc(32)
    runtime.writeUInt32LE(0xfeedfacf)
    runtime.writeUInt32LE(6, 12)
    const image = join(root, 'lib', 'libtest.dylib')
    writeFileSync(image, runtime)
    writeFileSync(join(root, 'lib', 'archive.a'), '!<arch>\n')
    const object = Buffer.from(runtime)
    object.writeUInt32LE(1, 12)
    writeFileSync(join(root, 'lib', 'object.o'), object)
    symlinkSync('libtest.dylib', join(root, 'lib', 'libtest.1.dylib'))
    symlinkSync('..', join(root, 'lib', 'loop'))
    const paths: string[] = []
    for (const baseline of ['14', '14.0', '14.0.0']) {
      expect(verifyMacOSDeploymentTarget(root, baseline, path => {
        paths.push(path)
        return `${path}:\n${modern('14.0')}`
      })).toEqual([image])
    }
    expect(paths).toEqual([image, image, image])
    expect(() => verifyMacOSDeploymentTarget(root, '14.0', () => `/image (architecture arm64):\n${modern('13.0')}/image (architecture x86_64):\n${legacy('14.0.1')}`)).toThrow('requires macOS 14.0.1, newer than declared 14.0')
    expect(() => verifyMacOSDeploymentTarget(root, '14.0', () => modern('27.0'))).toThrow('requires macOS 27.0')
    expect(() => verifyMacOSDeploymentTarget(root, '14.0', () => { throw new Error('otool failed') })).toThrow('otool failed')
    for (const baseline of [undefined, null, 14, '', '14.x', '14.0.0.1', '0', '99999999999999999999'])
      expect(() => verifyMacOSDeploymentTarget(root, baseline, () => modern('14.0'))).toThrow('Invalid macOS deployment version')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
