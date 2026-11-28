import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PackageRecipe } from '../scripts/buildkit'
import { generateBuildScript } from '../scripts/buildkit'
import { recipe as awsCliRecipe } from '../src/recipes/aws.amazon.com/cli'

describe('Python-backed package runtime wrappers', () => {
  test('CPython preserves the Tcl/Tk 8.6 runtime required by its tkinter extension', async () => {
    const { loadRecipe } = await import('../scripts/recipe-loader')
    for (const platform of ['darwin-arm64', 'linux-arm64', 'linux-x86-64']) {
      const { recipe } = await loadRecipe('python.org', platform, '3.12.14')
      expect(recipe.dependencies?.['tcl-lang.org']).toBe('~8.6')
    }
  })

  test('only Linux CPython releases that still implement NIS declare its managed ABI', async () => {
    const { loadRecipe } = await import('../scripts/recipe-loader')
    for (const platform of ['linux-arm64', 'linux-x86-64', 'darwin-arm64']) {
      for (const version of ['3.12.14', '3.13.10', '3.14.0']) {
        const { recipe } = await loadRecipe('python.org', platform, version)
        const linux = recipe.dependencies?.linux
        if (platform.startsWith('linux') && version.startsWith('3.12.')) {
          expect(linux?.['github.com/thkukuk/libnsl']).toBe('^2')
          expect(linux?.['sourceforge.net/libtirpc']).toBe('^1')
          expect(linux?.['github.com/besser82/libxcrypt']).toBe('^4')
        }
        else if (!version.startsWith('3.12.')) expect(linux?.['github.com/thkukuk/libnsl']).toBeUndefined()
        const script = generateBuildScript(recipe as PackageRecipe, 'python.org', version, platform, '/tmp/python', '/tmp/build', {})
        const syntax = spawnSync('/bin/bash', ['-n'], { input: script, encoding: 'utf8' })
        expect(syntax.status).toBe(0)
        if (platform.startsWith('darwin')) expect(script).toContain('LIBMPDEC_CFLAGS="-DCONFIG_64=1"')
        expect(recipe.test?.required).toBe(true)
      }
    }
  })

  test('AWS CLI declares Python as a runtime dependency', () => {
    expect(awsCliRecipe.dependencies?.['python.org']).toBe('>=3.11<3.15')
  })

  test('bkpyvenv wrappers resolve Pantry-managed Python at runtime', () => {
    const buildRecipe: PackageRecipe = {
      build: awsCliRecipe.build,
      buildDependencies: awsCliRecipe.buildDependencies,
      dependencies: awsCliRecipe.dependencies,
    }
    const script = generateBuildScript(
      buildRecipe,
      'aws.amazon.com/cli',
      '2.34.15',
      'darwin-aarch64',
      '/tmp/aws-cli',
      '/tmp/build',
      { 'python.org': '/tmp/python' },
    )

    expect(script).toContain('SEARCH_DIR="$SCRIPT_DIR"')
    expect(script).toContain('if [ -x "$SEARCH_DIR/.bin/python3" ]')
    expect(script).toContain('exec "$PYTHON_BIN" "$VENV_DIR/bin/%s" "$@"')
  })

  test.skipIf(process.platform === 'win32')('mirrored AWS launches repair missing and stale runtimes concurrently', async () => {
    const python = Bun.which('python3')
    if (!python) throw new Error('python3 is required for the mirrored launcher test')
    const selected = spawnSync(python, ['-c', 'import os, sys; print(os.path.realpath(sys.executable))'], { encoding: 'utf8' })
    expect(selected.status).toBe(0)
    const pythonTarget = selected.stdout.trim()
    const directory = await mkdtemp(join(tmpdir(), 'pantry-aws-venv-'))
    const launcher = resolve(import.meta.dir, '../../zig/src/install/aws_venv_launcher.py')
    const entrypoint = '#!/old/build/location/venv/bin/python\nimport json, sys\nprint(json.dumps([sys.prefix, sys.argv[1:]]))\n'

    try {
      let pkg = join(directory, 'original package')
      await mkdir(join(pkg, 'bin'), { recursive: true })
      await mkdir(join(pkg, 'venv/bin'), { recursive: true })
      await writeFile(join(pkg, 'bin/aws'), await readFile(launcher))
      await writeFile(join(pkg, 'venv/bin/aws'), entrypoint)

      const run = async () => {
        const processes = Array.from({ length: 12 }, () => Bun.spawn(
          [python, join(pkg, 'bin/aws'), 'a b', '--version'],
          { stdout: 'pipe', stderr: 'pipe' },
        ))
        for (const child of processes) {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
          expect(JSON.parse(stdout)).toEqual([join(pkg, 'venv'), ['a b', '--version']])
        }
      }

      pkg = await realpath(pkg)
      await run()
      const runtime = join(pkg, 'venv/bin/python')
      const config = join(pkg, 'venv/pyvenv.cfg')
      const warm = [(await lstat(runtime, { bigint: true })).ino, (await lstat(config, { bigint: true })).ino]
      await run()
      expect([(await lstat(runtime, { bigint: true })).ino, (await lstat(config, { bigint: true })).ino]).toEqual(warm)

      await rm(runtime)
      await symlink('/missing/python', runtime)
      await writeFile(config, 'home = /old/build/location\n')
      const moved = join(await realpath(directory), 'relocated package')
      await rename(pkg, moved)
      pkg = moved
      await run()
      expect(await readlink(join(pkg, 'venv/bin/python'))).toBe(pythonTarget)
      expect(await readFile(join(pkg, 'venv/bin/aws'), 'utf8')).toBe(entrypoint)
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
