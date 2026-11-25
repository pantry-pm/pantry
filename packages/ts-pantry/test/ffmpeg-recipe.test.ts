import { expect, test } from 'bun:test'
import { generateBuildScript } from '../scripts/buildkit'
import { loadRecipe } from '../scripts/recipe-loader'
import { ffmpegorgPackage } from '../src/packages/ffmpegorg'

// ffmpeg.org 9.0.2 for darwin-arm64 was a mirrored vendor archive: it linked
// `@rpath/harfbuzz.org/v8/lib/libharfbuzz.dylib`, a major the registry does
// not carry, and its dylibs had 56 bytes of Mach-O header slack. A fresh
// install either failed (MacOSLibraryRpathFixFailed) or produced an ffmpeg
// that dyld could not start.
test('ffmpeg 9.0.2 is republished as a recipe build, never the mirrored archive', async () => {
  for (const platform of ['darwin-arm64', 'linux-x86-64', 'linux-arm64']) {
    const loaded = await loadRecipe('ffmpeg.org', platform, '9.0.2')
    expect(loaded.upstreamVersion).toBe('9.0.2')
    expect(loaded.publicationVersion).toBe('9.0.2.1')
    expect(loaded.requiresRecipeBuild).toBe(true)
  }
  // Present, not newest: the package updater adds later upstream releases
  // ahead of it, and a pin on versions[0] blocked every such update.
  expect(ffmpegorgPackage.versions as readonly string[]).toContain('9.0.2.1')
  // The published identity stays readable; it is superseded, not replaced.
  expect(ffmpegorgPackage.versions).toContain('9.0.2')
})

test('the Darwin build leaves room for load command rewrites and Linux is untouched', async () => {
  const { recipe, upstreamVersion } = await loadRecipe('ffmpeg.org', 'darwin-arm64', '9.0.2')
  const script = generateBuildScript(recipe, 'ffmpeg.org', upstreamVersion!, 'darwin-arm64', '/package/v9.0.2.1', '/source', {})
  expect(script).toContain('if [ "$(uname)" = "Darwin" ]; then')
  expect(script).toContain('ARGS="$ARGS --extra-ldflags=-Wl,-headerpad_max_install_names"')
  // The source archive is the vendor's 9.0.2, not a "9.0.2.1" that does not exist.
  expect(script).not.toContain('ffmpeg-9.0.2.1')
})

test('publication requires real encodes through every linked codec, without loader variables', async () => {
  const { recipe } = await loadRecipe('ffmpeg.org', 'darwin-arm64', '9.0.2')
  expect(recipe.test?.required).toBe(true)
  const script = (recipe.test?.script ?? []).join('\n')
  expect(script).toContain('env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH')
  expect(script).toContain('{{prefix}}/bin/ffmpeg -version')
  expect(script).toContain('{{prefix}}/bin/ffprobe -version')
  for (const codec of ['libx264', 'aac', 'libvpx-vp9', 'libopus', 'libx265', 'libmp3lame', 'libwebp'])
    expect(script).toContain(codec)
  expect(script).toContain('= "h264 aac "')
  expect(script).toContain('drawtext')
  // Every command goes through `run`, so none can lean on the build's library path.
  for (const line of script.split('\n').slice(1)) expect(line).toMatch(/^(?:run |test "\$\(run )/)
})

// The linux-x86-64 build of 9.0.2.1 stopped at "nasm not found or too old":
// the recipe's `x86-64` build dependency group was dropped, and once it was
// read, `nasm.us 2` matched no archive: the registry only builds nasm 3.x.
test('an architecture group of dependencies reaches the builds of that architecture only', async () => {
  const { extractYamlDeps } = await import('../scripts/build-package')
  const build = (await loadRecipe('ffmpeg.org', 'linux-x86-64', '9.0.2')).recipe.build!.dependencies
  expect(extractYamlDeps(build, 'linux-x86-64')).toContain('nasm.us >=2.14')
  expect(extractYamlDeps(build, 'darwin-x86-64')).toContain('nasm.us >=2.14')
  expect(extractYamlDeps(build, 'linux-arm64')).not.toContain('nasm.us >=2.14')
  expect(extractYamlDeps(build, 'darwin-arm64')).not.toContain('nasm.us >=2.14')

  const groups = { 'a.org': '^1', 'b.org': '*', 'linux': { 'c.org': '2' }, 'linux/aarch64': { 'd.org': '3' }, 'darwin/x86-64': { 'e.org': '4' }, 'aarch64': { 'f.org': '5' } }
  expect(extractYamlDeps(groups, 'linux-arm64')).toEqual(['a.org ^1', 'b.org', 'c.org 2', 'd.org 3', 'f.org 5'])
  expect(extractYamlDeps(groups, 'linux-x86-64')).toEqual(['a.org ^1', 'b.org', 'c.org 2'])
  expect(extractYamlDeps(groups, 'darwin-arm64')).toEqual(['a.org ^1', 'b.org', 'f.org 5'])
  expect(extractYamlDeps(groups, 'darwin-x86-64')).toEqual(['a.org ^1', 'b.org', 'e.org 4'])
})
