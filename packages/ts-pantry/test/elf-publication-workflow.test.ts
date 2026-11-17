import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('mirror and download publishers install only their runtime and provision Linux ELF tools', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../../../.github/workflows/mirror.yml', import.meta.url), 'utf8')) as {
    jobs: Record<string, { steps: Array<{ uses?: string, if?: string, with?: { packages?: string, install?: string } }> }>
  }
  for (const name of ['mirror', 'download']) {
    const steps = workflow.jobs[name].steps
    const setup = steps.findIndex(step => step.uses === './packages/action')
    const normalizer = steps.findIndex(step => step.with?.packages === 'nixos.org/patchelf@0.18.0')
    expect(setup).toBeGreaterThan(-1)
    expect(steps[setup].with?.packages).toBe('bun.sh')
    expect(normalizer).toBeGreaterThan(setup)
    expect(steps[normalizer].uses).toBe('./packages/action')
    expect(steps[normalizer].if).toBe("startsWith(matrix.name, 'linux-')")
    expect(steps[normalizer].with?.install).toBe('false')
  }
})

test('targeted mirror dispatch preserves exact selectors and keeps scheduled runs incremental', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../../../.github/workflows/mirror.yml', import.meta.url), 'utf8')) as {
    jobs: Record<string, { steps: Array<{ run?: string }> }>
  }
  const root = mkdtempSync(join(tmpdir(), 'pantry-mirror-dispatch-'))
  try {
    mkdirSync(join(root, 'packages/ts-pantry'), { recursive: true })
    const executable = join(root, 'bun')
    const output = join(root, 'arguments')
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGUMENTS"\n')
    chmodSync(executable, 0o755)
    for (const job of ['mirror', 'download']) {
      const source = workflow.jobs[job].steps.find(step => step.run?.includes('bun scripts/build-all-packages.ts'))!.run!
      const script = source.replace(/\$\{\{.*?\}\}/g, expression => expression.includes('stripe') ? '0/1' : expression.includes('matrix.name') ? 'linux-x86-64' : '1')
      for (const targeted of [false, true]) {
        for (const repair of [false, true]) {
          const selector = 'openssl.org@1.1.1w,openssl.org@3.6.5;$(touch should-not-execute)'
          // macOS Actions runs the system Bash 3.2, which treats an empty array
          // as unbound under nounset. Do not silently test a Homebrew Bash here.
          const result = spawnSync(process.platform === 'darwin' ? '/bin/bash' : 'bash', ['-c', script], {
            cwd: root,
            env: { ...process.env, PATH: `${root}:${process.env.PATH}`, ARGUMENTS: output, S3_BUCKET: 'test-bucket', AWS_REGION: 'test-region', RUNNER_TEMP: root, TARGET_PACKAGES: targeted ? selector : '', REBUILD_EXISTING: String(repair) },
            encoding: 'utf8',
          })
          expect(result.status, result.stderr).toBe(0)
          const args = readFileSync(output, 'utf8').trim().split('\n')
          expect(args.includes('--force')).toBe(repair)
          expect(args.includes('--package')).toBe(targeted)
          if (targeted) expect(args[args.indexOf('--package') + 1]).toBe(selector)
          expect(args).toContain(job === 'mirror' ? '--mirror-only' : '--download-only')
        }
      }
    }
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('Darwin vendor downloads are selected for the native Mach-O publisher', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../../../.github/workflows/publish-changed-packages.yml', import.meta.url), 'utf8')) as {
    jobs: Record<string, { 'runs-on'?: string, if?: string, strategy?: { matrix: { platform: Array<{ name: string, os: string }> } }, steps: Array<{ name?: string, run?: string, env?: Record<string, string> }> }>
  }
  const root = mkdtempSync(join(tmpdir(), 'pantry-native-darwin-selection-'))
  try {
    const select = workflow.jobs.detect.steps.find(step => step.name === 'Determine darwin-native domains')!
    expect(select.env?.DOMAINS).toBe('${{ steps.owners.outputs.domains }}')
    const output = join(root, 'output')
    for (const domains of ['bun.com@1.4.3', '']) {
      writeFileSync(output, '')
      // Execute the real script unchanged, with the same environment handoff
      // Actions provides. No step-name-specific source substitution is needed.
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', select.run!], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, DOMAINS: domains, GITHUB_OUTPUT: output },
        encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(output, 'utf8').trim()).toBe(`domains=${domains}`)
    }
    const native = workflow.jobs['publish-darwin-native']
    expect(native['runs-on']).toBe('${{ matrix.runner }}')
    expect(native.steps.find(step => step.name === 'Build and publish darwin-arm64 (native)')!.run).not.toContain('--source-only')
    expect(workflow.jobs.build.if).toContain("inputs.platform != 'darwin-arm64'")
    expect(workflow.jobs.build.strategy!.matrix.platform.every(platform => platform.name.startsWith('linux-'))).toBe(true)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('scheduled Darwin mirror and download matrices use native macOS runners', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../../../.github/workflows/mirror.yml', import.meta.url), 'utf8')) as {
    jobs: Record<string, { steps: Array<{ id?: string, run?: string }> }>
  }
  const root = mkdtempSync(join(tmpdir(), 'pantry-mirror-native-matrix-'))
  try {
    const output = join(root, 'output')
    const script = workflow.jobs.setup.steps.find(step => step.id === 'gen')!.run!
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      env: { ...process.env, PLATFORM: 'darwin-arm64', STRIPES: '1', GITHUB_OUTPUT: output },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    const matrices = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), JSON.parse(line.slice(line.indexOf('=') + 1))]))
    for (const name of ['matrix', 'download_matrix'])
      expect(matrices[name].include).toEqual([{ name: 'darwin-arm64', os: 'macos-15', stripe: '0/1' }])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('Darwin source builds go to the self-hosted Mac and mirrors stay on hosted macos-15', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../../../.github/workflows/publish-changed-packages.yml', import.meta.url), 'utf8')) as {
    jobs: Record<string, { steps: Array<{ name?: string, id?: string, run?: string, if?: string }> }>
  }
  const split = workflow.jobs.detect.steps.find(step => step.id === 'darwin-legs')!
  const root = mkdtempSync(join(tmpdir(), 'pantry-darwin-legs-'))
  try {
    const output = join(root, 'output')
    // qemu.org is a custom source build: --exclude-pkgx-covered keeps it
    // without consulting pkgx, so this needs no network.
    for (const [native, legs] of [
      ['', []],
      ['qemu.org', [{ leg: 'source', runner: 'pantry-mac-self-hosted', self_hosted: true, domains: 'qemu.org' }]],
    ] as const) {
      writeFileSync(output, '')
      const result = spawnSync('bash', ['-c', split.run!], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, NATIVE: native, MAXV: '1', POPULAR_MAXV: '1', GITHUB_OUTPUT: output },
        encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(0)
      const line = readFileSync(output, 'utf8').trim()
      expect(JSON.parse(line.slice('legs='.length))).toEqual(legs)
    }
    const contain = (workflow.jobs['publish-darwin-native'].steps).find(step => step.name === 'Contain the self-hosted Mac build')!
    expect(contain.if).toBe('matrix.self_hosted')
    expect(contain.run).toContain('MACOSX_DEPLOYMENT_TARGET=15.0')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('build.yml routes targeted darwin source builds to the self-hosted Mac only', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../../../.github/workflows/build.yml', import.meta.url), 'utf8')) as {
    jobs: Record<string, { 'runs-on'?: string, steps: Array<{ id?: string, name?: string, run?: string, if?: string }> }>
  }
  const script = workflow.jobs.route.steps.find(step => step.id === 'matrix')!.run!
  const root = mkdtempSync(join(tmpdir(), 'pantry-build-route-'))
  try {
    const output = join(root, 'output')
    const route = (env: Record<string, string>) => {
      writeFileSync(output, '')
      const result = spawnSync('bash', ['-c', script], {
        cwd: new URL('../../..', import.meta.url),
        env: { ...process.env, PLATFORM: 'all', APPS_ONLY: 'false', PACKAGES: '', MULTI_VERSION: 'false', GITHUB_OUTPUT: output, ...env },
        encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(0)
      const line = readFileSync(output, 'utf8').trim()
      return JSON.parse(line.slice('matrix='.length)) as Array<{ os: string, name: string, packages: string, self_hosted: boolean }>
    }
    // A whole-catalog or apps-only sweep never lands on the laptop.
    expect(route({}).map(entry => entry.os)).toEqual(['macos-15', 'ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-latest'])
    expect(route({ APPS_ONLY: 'true' }).some(entry => entry.self_hosted)).toBe(false)
    // A custom source build is routed to the self-hosted label, alone.
    expect(route({ PLATFORM: 'darwin-arm64', PACKAGES: 'qemu.org' })).toEqual([
      { os: 'pantry-mac-self-hosted', name: 'darwin-arm64', label: 'darwin-arm64 source', packages: 'qemu.org', self_hosted: true },
    ])
    const steps = (workflow.jobs.build as unknown as { steps: Array<{ name?: string, if?: string }> }).steps
    expect(steps.find(step => step.name === 'Setup Xcode (macOS)')!.if).toContain('!matrix.platform.self_hosted')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
