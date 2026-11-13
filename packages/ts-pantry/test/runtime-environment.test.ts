import { describe, expect, test } from 'bun:test'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dependencyRuntimeEnvironment, resolveRuntimeEnvironment, runtimeEnvironmentScript } from '../scripts/runtime-environment'
import { loadRecipe } from '../scripts/recipe-loader'

describe('declared package runtime environment', () => {
  test.skipIf(process.platform === 'win32')('POSIX launchers execute literal defaults safely and keep caller overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry-runtime-env-'))
    try {
      const marker = join(root, 'must-not-execute')
      const values = resolveRuntimeEnvironment({
        PACKAGE_DATA: '${{prefix}}/data with spaces',
        LITERAL: `quote' " dollar$ backtick\` $(touch '${marker}')\nsecond line`,
      }, root)
      const script = runtimeEnvironmentScript(values) + '\nprintf "%s\\0%s" "$PACKAGE_DATA" "$LITERAL"'
      const normal = Bun.spawnSync(['/bin/sh', '-c', script], { env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' })
      expect(normal.exitCode, normal.stderr.toString()).toBe(0)
      expect(normal.stdout.toString().split('\0')).toEqual([`${root}/data with spaces`, values.LITERAL!])
      expect(existsSync(marker)).toBe(false)
      const overridden = Bun.spawnSync(['/bin/sh', '-c', script], { env: { PATH: process.env.PATH, PACKAGE_DATA: 'caller directory' }, stdout: 'pipe', stderr: 'pipe' })
      expect(overridden.exitCode, overridden.stderr.toString()).toBe(0)
      expect(overridden.stdout.toString().split('\0')[0]).toBe('caller directory')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('uses the relocated prefix rather than retaining the build prefix', () => {
    const template = { RESOURCE_ROOT: '{{prefix}}/lib' }
    expect(resolveRuntimeEnvironment(template, '/first install/package')).toEqual({ RESOURCE_ROOT: '/first install/package/lib' })
    expect(resolveRuntimeEnvironment(template, '/relocated/package')).toEqual({ RESOURCE_ROOT: '/relocated/package/lib' })
    expect(resolveRuntimeEnvironment(template, '/literal{{directory}}')).toEqual({ RESOURCE_ROOT: '/literal{{directory}}/lib' })
  })

  test('rejects malformed variables and unsupported placeholders before rendering a shell', () => {
    for (const key of ['BAD-NAME', 'BAD NAME', '$(touch bad)', ''])
      expect(() => resolveRuntimeEnvironment({ [key]: 'value' }, '/prefix')).toThrow()
    expect(() => resolveRuntimeEnvironment({ VALID: 'nul\0byte' }, '/prefix')).toThrow()
    expect(() => resolveRuntimeEnvironment({ VALID: '{{unknown}}/lib' }, '/prefix')).toThrow()
    expect(() => runtimeEnvironmentScript({ 'BAD-NAME': 'value' })).toThrow()
  })

  test('does not add any exports to packages without a runtime contract', () => {
    expect(resolveRuntimeEnvironment(undefined, '/prefix')).toEqual({})
    expect(runtimeEnvironmentScript({})).toBe('')
  })

  test('resolves the real SWIG declaration for direct and isolated selected dependencies', async () => {
    const load = async (domain: string, version: string) => (await loadRecipe(domain, 'linux-x86-64', version)).recipe.runtime?.env
    expect(await dependencyRuntimeEnvironment({
      'deps.swig.org.prefix': '/selected/swig',
      'deps.swig.org.version': '4.5.1',
    }, load)).toEqual({ SWIG_LIB: '/selected/swig/lib' })
    expect(await dependencyRuntimeEnvironment({
      'build-tools.tool.org:swig.org.prefix': '/private/swig',
      'build-tools.tool.org:swig.org.version': '4.5.1',
    }, load)).toEqual({ SWIG_LIB: '/private/swig/lib' })
    await expect(dependencyRuntimeEnvironment({ 'deps.swig.org.prefix': '/missing-version' }, load)).rejects.toThrow('Missing selected runtime version')
    await expect(dependencyRuntimeEnvironment({
      'deps.swig.org.prefix': '/selected/swig',
      'deps.swig.org.version': '4.5.1',
      'build-tools.tool.org:swig.org.prefix': '/private/swig',
      'build-tools.tool.org:swig.org.version': '4.5.1',
    }, load)).rejects.toThrow('Conflicting package runtime variable SWIG_LIB')
  })
})
