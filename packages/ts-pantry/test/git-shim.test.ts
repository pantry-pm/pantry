import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Git shim resolves aliases through its native binary without calling itself through PATH', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-git-shim-'))
  try {
    const registry = join(directory, 'pantry')
    const prefix = join(registry, 'git-scm.org/v2.53.0')
    const ownedLibrary = join(registry, 'gnu.org/libiconv/v1.19.0/lib')
    const libraryTrace = join(directory, 'library-path')
    mkdirSync(ownedLibrary, { recursive: true })
    for (const path of [join(prefix, 'bin'), join(prefix, 'libexec'), join(directory, 'trap')]) mkdirSync(path, { recursive: true })
    const shim = join(prefix, 'bin/git')
    writeFileSync(shim, readFileSync(join(import.meta.dir, '../src/recipes/props/git-scm.org/git-shim')))
    writeFileSync(join(prefix, 'libexec/git'), '#!/bin/sh\nprintf "%s" "$LD_LIBRARY_PATH" > "$LIBRARY_TRACE"\nif [ "$1" = config ]; then echo alias.saved; else printf "%s\\n" "$*"; fi\n')
    // A PATH Git stands in for the installed shim, but fails instead of forking
    // recursively. Alias discovery must call libexec/git directly.
    writeFileSync(join(directory, 'trap/git'), '#!/bin/sh\necho recursive-git-wrapper >&2\nexit 1\n')
    // uname is an authored external Linux boundary on macOS, not Linux native qualification.
    writeFileSync(join(directory, 'trap/uname'), '#!/bin/sh\nprintf "Linux\\n"\n')
    for (const path of [shim, join(prefix, 'libexec/git'), join(directory, 'trap/git'), join(directory, 'trap/uname')]) chmodSync(path, 0o755)
    for (const command of ['status', 'saved', 'config']) {
      const child = Bun.spawn([shim, command], { env: { ...process.env, LIBRARY_TRACE: libraryTrace, PATH: `${join(directory, 'trap')}:/usr/bin:/bin` }, stdout: 'pipe', stderr: 'pipe' })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code).toBe(0)
      expect(stderr).toBe('')
      expect(stdout.trim()).toBe(command === 'config' ? 'alias.saved' : command)
      expect(readFileSync(libraryTrace, 'utf8')).toBe(`${process.env.LD_LIBRARY_PATH ? `${process.env.LD_LIBRARY_PATH}:` : ''}${ownedLibrary}`)
    }
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Git launcher resolves relocated Linux libraries while preserving an explicit loader path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-git-libraries-'))
  try {
    const registry = join(directory, 'pantry')
    const prefix = join(registry, 'git-scm.org/v2.53.0')
    const iconv = join(registry, 'gnu.org/libiconv/v1.19.0/lib')
    const curl = join(registry, 'curl.se/v8.22.0/lib')
    const trap = join(directory, 'trap')
    const foreign = join(directory, 'foreign/not-owned.org/v1.0.0/lib')
    for (const path of [join(prefix, 'bin'), join(prefix, 'libexec'), iconv, curl, trap, foreign]) mkdirSync(path, { recursive: true })
    const shim = join(prefix, 'bin/git')
    writeFileSync(shim, readFileSync(join(import.meta.dir, '../src/recipes/props/git-scm.org/git-shim')))
    writeFileSync(join(prefix, 'libexec/git'), '#!/bin/sh\nprintf "%s" "$LD_LIBRARY_PATH"\n')
    writeFileSync(join(trap, 'uname'), '#!/bin/sh\necho Linux\n')
    for (const path of [shim, join(prefix, 'libexec/git'), join(trap, 'uname')]) chmodSync(path, 0o755)
    const child = Bun.spawn([shim, '--version'], { env: { ...process.env, LD_LIBRARY_PATH: '/explicit/lib', PATH: `${trap}:/usr/bin:/bin` }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.split(':')).toEqual(['/explicit/lib', curl, iconv])
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Git shell helpers source the real gettext library and return to their caller', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-git-gettext-'))
  try {
    const prefix = join(directory, 'pantry/git-scm.org/v2.53.0')
    const gettext = join(directory, 'pantry/gnu.org/gettext/v0.21.1/bin')
    const trap = join(directory, 'trap')
    for (const path of [join(prefix, 'bin'), join(prefix, 'libexec'), gettext, trap]) mkdirSync(path, { recursive: true })
    const shim = join(prefix, 'bin/git')
    writeFileSync(shim, readFileSync(join(import.meta.dir, '../src/recipes/props/git-scm.org/git-shim')))
    writeFileSync(join(gettext, 'gettext.sh'), 'gettext_fixture() { printf "sourced-library"; }\n')
    writeFileSync(join(trap, 'gettext.sh'), 'echo launched-library >&2\nexit 7\n')
    writeFileSync(join(prefix, 'libexec/git'), '#!/bin/sh\n. gettext.sh\ngettext_fixture\nprintf ":returned"\n')
    for (const path of [shim, join(prefix, 'libexec/git')]) chmodSync(path, 0o755)
    const child = Bun.spawn([shim, '--version'], { env: { ...process.env, PATH: `${trap}:/usr/bin:/bin` }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toBe('sourced-library:returned')
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
})

test('command-line and repository aliases never trigger external provider discovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pantry-git-alias-context-'))
  try {
    const prefix = join(directory, 'pantry/git-scm.org/v2.53.0')
    const trap = join(directory, 'trap')
    const repository = join(directory, 'repository with spaces')
    const marker = join(directory, 'provider-was-called')
    for (const path of [join(prefix, 'bin'), join(prefix, 'libexec'), trap]) mkdirSync(path, { recursive: true })
    const shim = join(prefix, 'bin/git')
    writeFileSync(shim, readFileSync(join(import.meta.dir, '../src/recipes/props/git-scm.org/git-shim')))
    // The operating system Git is the authored fixture engine. The copied
    // launcher is the source under test, with real native alias parsing.
    writeFileSync(join(prefix, 'libexec/git'), '#!/bin/sh\nexec /usr/bin/git "$@"\n')
    writeFileSync(join(trap, 'pkgx'), '#!/bin/sh\nprintf called >> "$PROVIDER_MARKER"\nexit 9\n')
    for (const path of [shim, join(prefix, 'libexec/git'), join(trap, 'pkgx')]) chmodSync(path, 0o755)
    expect(Bun.spawnSync(['/usr/bin/git', 'init', '--bare', repository], { stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0)
    expect(Bun.spawnSync(['/usr/bin/git', '--git-dir', repository, 'config', 'alias.saved', '!printf repository-alias']).exitCode).toBe(0)
    const cases = [
      { args: ['-c', 'alias.inline=!printf command-line-alias', 'inline'], output: 'command-line-alias' },
      { args: [`--git-dir=${repository}`, 'saved'], output: 'repository-alias' },
      { args: ['-c', 'alias.inline=!printf ignored', '-c', 'alias.inline=!printf overridden', 'inline'], output: 'overridden' },
      { args: ['--git-dir', repository, 'saved'], output: 'repository-alias' },
      { args: ['--config-env=alias.inline=PANTRY_ALIAS_FIXTURE', 'inline'], output: 'environment-alias' },
    ]
    for (const entry of cases) {
      const child = Bun.spawn([shim, ...entry.args], { env: { ...process.env, PANTRY_ALIAS_FIXTURE: '!printf environment-alias', PROVIDER_MARKER: marker, PATH: `${trap}:/usr/bin:/bin` }, stdout: 'pipe', stderr: 'pipe' })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect({ args: entry.args, code, stdout, stderr }).toEqual({ args: entry.args, code: 0, stdout: entry.output, stderr: '' })
      expect(await Bun.file(marker).exists()).toBe(false)
    }
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
})
