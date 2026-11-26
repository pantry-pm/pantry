import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixUp } from '../scripts/fix-up'
import { linkTimeLibraryName, shipsLinkTimeName } from '../scripts/native-runtime'

test('link-time names drop the version, whatever the object format', () => {
  expect(linkTimeLibraryName('libintl.8.dylib')).toBe('libintl.dylib')
  expect(linkTimeLibraryName('libicuuc.73.2.dylib')).toBe('libicuuc.dylib')
  expect(linkTimeLibraryName('libsqlite3.dylib')).toBe('libsqlite3.dylib')
  expect(linkTimeLibraryName('libz.so.1')).toBe('libz.so')
  expect(linkTimeLibraryName('libstdc++.so.6.0.33')).toBe('libstdc++.so')
  expect(linkTimeLibraryName('libgettextlib-0.26.dylib')).toBe('libgettextlib.dylib')
  expect(linkTimeLibraryName('libpython3.11.dylib')).toBe('libpython3.dylib')
  expect(linkTimeLibraryName('libsodium.26.dylib')).toBe('libsodium.dylib')
})

test('only the package whose link-time name resolves to the file owns it', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-link-owner-'))
  try {
    mkdirSync(join(root, 'owner/lib'), { recursive: true })
    mkdirSync(join(root, 'copy/lib'), { recursive: true })
    mkdirSync(join(root, 'other/lib'), { recursive: true })
    writeFileSync(join(root, 'owner/lib/libintl.8.dylib'), 'owner')
    symlinkSync('libintl.8.dylib', join(root, 'owner/lib/libintl.dylib'))
    writeFileSync(join(root, 'copy/lib/libintl.8.dylib'), 'copy')
    writeFileSync(join(root, 'other/lib/libintl.8.dylib'), 'other')
    writeFileSync(join(root, 'other/lib/libintl.9.dylib'), 'newer')
    symlinkSync('libintl.9.dylib', join(root, 'other/lib/libintl.dylib'))
    expect(shipsLinkTimeName(join(root, 'owner/lib/libintl.8.dylib'))).toBe(true)
    expect(shipsLinkTimeName(join(root, 'copy/lib/libintl.8.dylib'))).toBe(false)
    // The link-time name must lead to THIS file, not merely exist.
    expect(shipsLinkTimeName(join(root, 'other/lib/libintl.8.dylib'))).toBe(false)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

// php.net on darwin: gnu.org/bison, sed and m4 (published before runtime
// receipts) each carry a libintl.8.dylib copy beside gnu.org/gettext, which
// owns it. Bundling php's closure failed on "Conflicting declared runtime
// providers for libintl.8.dylib" although php linked gettext's.
test.skipIf(process.platform !== 'darwin')('a receipt-less runtime copy does not compete with the library the binary linked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-link-owner-macho-'))
  const environment = { ...process.env }
  for (const key of ['DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'LD_LIBRARY_PATH', 'LD_PRELOAD']) delete environment[key]
  const run = (command: string[]) => {
    const child = Bun.spawnSync(command, { cwd: root, env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    return child.stdout.toString().trim()
  }
  try {
    const owner = join(root, 'deps/gnu.org/gettext/0.26')
    const copier = join(root, 'deps/gnu.org/sed/4.10')
    const stage = join(root, 'artifact')
    for (const path of [join(owner, 'lib'), join(copier, 'lib'), join(stage, 'bin')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(root, 'intl.c'), 'int intl_value(void) { return 42; }')
    writeFileSync(join(root, 'stale.c'), 'int intl_value(void) { return 7; }')
    writeFileSync(join(root, 'main.c'), '#include <stdio.h>\nextern int intl_value(void); int main(void) { printf("%d\\n", intl_value()); return 0; }')
    const ownerLib = join(owner, 'lib/libfixtureintl.8.dylib')
    run(['xcrun', 'clang', '-dynamiclib', join(root, 'intl.c'), '-Wl,-headerpad_max_install_names', '-install_name', '@rpath/libfixtureintl.8.dylib', '-o', ownerLib])
    symlinkSync('libfixtureintl.8.dylib', join(owner, 'lib/libfixtureintl.dylib'))
    run(['xcrun', 'clang', '-dynamiclib', join(root, 'stale.c'), '-Wl,-headerpad_max_install_names', '-install_name', '@rpath/libfixtureintl.8.dylib', '-o', join(copier, 'lib/libfixtureintl.8.dylib')])
    run(['xcrun', 'clang', join(root, 'main.c'), `-L${owner}/lib`, '-lfixtureintl', '-Wl,-headerpad_max_install_names', '-o', join(stage, 'bin/fixture')])

    const dependencies = [
      { domain: 'gnu.org/sed', version: '4.10', prefix: copier },
      { domain: 'gnu.org/gettext', version: '0.26', prefix: owner },
    ]
    await fixUp(stage, 'darwin-arm64', [], dependencies)
    rmSync(join(root, 'deps'), { recursive: true, force: true })
    expect(run([join(stage, 'bin/fixture')])).toBe('42')
    const receipts = JSON.parse(readFileSync(join(stage, 'share/pantry/runtime-libraries.json'), 'utf8')).libraries
    expect(receipts.map((library: { name: string, domain: string }) => [library.name, library.domain])).toEqual([['libfixtureintl.8.dylib', 'gnu.org/gettext']])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== 'darwin')('two linkable providers with different bytes still conflict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-link-owner-conflict-'))
  try {
    const first = join(root, 'first')
    const second = join(root, 'second')
    const stage = join(root, 'artifact')
    for (const path of [join(first, 'lib'), join(second, 'lib'), join(stage, 'bin')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(root, 'a.c'), 'int v(void) { return 1; }')
    writeFileSync(join(root, 'b.c'), 'int v(void) { return 2; }')
    writeFileSync(join(root, 'main.c'), 'extern int v(void); int main(void) { return v(); }')
    for (const [dir, source] of [[first, 'a.c'], [second, 'b.c']]) {
      Bun.spawnSync(['xcrun', 'clang', '-dynamiclib', join(root, source), '-Wl,-headerpad_max_install_names', '-install_name', '@rpath/libfixturev.1.dylib', '-o', join(dir, 'lib/libfixturev.1.dylib')])
      symlinkSync('libfixturev.1.dylib', join(dir, 'lib/libfixturev.dylib'))
    }
    Bun.spawnSync(['xcrun', 'clang', join(root, 'main.c'), `-L${first}/lib`, '-lfixturev', '-o', join(stage, 'bin/fixture')])
    await expect(fixUp(stage, 'darwin-arm64', [], [{ domain: 'first.example', version: '1', prefix: first }, { domain: 'second.example', version: '1', prefix: second }])).rejects.toThrow('Conflicting declared runtime providers')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

// php.net on darwin linked `@rpath/libxml2.dylib` (a copy postgresql bundles
// under libxml2's link-time name) while libxml2 2.13.9 (for a pkgx-built
// dependency) and 2.15.4 were both declared. Only 2.15.4 satisfies the
// compatibility version php recorded, and php shares one libxml2 image with
// the libxslt that names it libxml2.16.dylib.
test.skipIf(process.platform !== 'darwin')('an older version of a library never satisfies a newer link, and clients share one copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-link-compat-'))
  const environment = { ...process.env }
  for (const key of ['DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'LD_LIBRARY_PATH', 'LD_PRELOAD']) delete environment[key]
  const run = (command: string[]) => {
    const child = Bun.spawnSync(command, { cwd: root, env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    return child.stdout.toString().trim()
  }
  try {
    const older = join(root, 'deps/example.org/fx/2.13.9')
    const newer = join(root, 'deps/example.org/fx/2.15.4')
    const bundler = join(root, 'deps/example.org/pg/17.12')
    const stage = join(root, 'artifact')
    for (const path of [join(older, 'lib'), join(newer, 'lib'), join(bundler, 'lib'), join(bundler, 'share/pantry'), join(stage, 'bin'), join(stage, 'lib')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(root, 'old.c'), 'int fx(void) { return 7; }')
    writeFileSync(join(root, 'new.c'), 'int fx(void) { return 21; }')
    writeFileSync(join(root, 'xslt.c'), 'extern int fx(void); int xslt(void) { return fx(); }')
    writeFileSync(join(root, 'main.c'), '#include <stdio.h>\nextern int fx(void); extern int xslt(void); int main(void) { printf("%d\\n", fx() + xslt()); return 0; }')
    const dylib = (source: string, output: string, id: string, current: string, compatibility: string, ...extra: string[]) =>
      run(['xcrun', 'clang', '-dynamiclib', join(root, source), ...extra, '-Wl,-headerpad_max_install_names', '-install_name', id, '-current_version', current, '-compatibility_version', compatibility, '-o', output])
    dylib('old.c', join(older, 'lib/libfx.2.dylib'), '@rpath/libfx.2.dylib', '16.9.0', '16.0.0')
    symlinkSync('libfx.2.dylib', join(older, 'lib/libfx.dylib'))
    dylib('new.c', join(newer, 'lib/libfx.16.dylib'), '@rpath/libfx.16.dylib', '18.4.0', '18.0.0')
    symlinkSync('libfx.16.dylib', join(newer, 'lib/libfx.dylib'))
    // The bundler's copy of the newer library under its link-time name.
    dylib('new.c', join(bundler, 'lib/libfx.dylib'), '@rpath/libfx.dylib', '18.4.0', '18.0.0')
    const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
    writeFileSync(join(bundler, 'share/pantry/runtime-libraries.json'), JSON.stringify({ version: 1, libraries: [{ name: 'libfx.dylib', domain: 'example.org/fx', version: '2.15.4', source: 'lib/libfx.16.dylib', sourceSha256: sha(join(newer, 'lib/libfx.16.dylib')), licenseFiles: [], resources: [], bundledSha256: sha(join(bundler, 'lib/libfx.dylib')) }] }))
    // libxslt-like client inside the artifact names the ABI file directly.
    dylib('xslt.c', join(stage, 'lib/libxslt.1.dylib'), '@rpath/libxslt.1.dylib', '1.0.0', '1.0.0', join(newer, 'lib/libfx.16.dylib'))
    // php-like client linked the bundler's copy through -lfx.
    run(['xcrun', 'clang', join(root, 'main.c'), `-L${bundler}/lib`, '-lfx', join(stage, 'lib/libxslt.1.dylib'), '-Wl,-headerpad_max_install_names', '-o', join(stage, 'bin/fixture')])
    expect(run(['otool', '-L', join(stage, 'bin/fixture')])).toContain('@rpath/libfx.dylib (compatibility version 18.0.0')

    await fixUp(stage, 'darwin-arm64', [], [
      { domain: 'example.org/fx', version: '2.13.9', prefix: older },
      { domain: 'example.org/pg', version: '17.12', prefix: bundler },
      { domain: 'example.org/fx', version: '2.15.4', prefix: newer },
    ])
    rmSync(join(root, 'deps'), { recursive: true, force: true })
    expect(run([join(stage, 'bin/fixture')])).toBe('42')
    const linked = run(['otool', '-L', join(stage, 'bin/fixture')])
    expect(linked).toContain('@rpath/libfx.16.dylib')
    expect(linked).not.toContain('@rpath/libfx.dylib')
    expect(run(['otool', '-L', join(stage, 'lib/libxslt.1.dylib')])).toContain('@rpath/libfx.16.dylib')
    expect(readdirSync(join(stage, 'lib')).filter(name => name.startsWith('libfx')).sort()).toEqual(['libfx.16.dylib'])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

// grpc.io on darwin: the published re2 (pkgx layout) loads
// `@rpath/abseil.io/v20250127/lib/libabsl_die_if_null.dylib` while grpc links
// abseil 20250512 directly. Both lines ship libabsl_die_if_null.dylib, which
// failed as "Conflicting declared runtime providers"; the pkgx path names one.
test.skipIf(process.platform !== 'darwin')('a pkgx provider path selects the version it names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-link-pkgx-path-'))
  const environment = { ...process.env }
  for (const key of ['DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'LD_LIBRARY_PATH', 'LD_PRELOAD']) delete environment[key]
  const run = (command: string[]) => {
    const child = Bun.spawnSync(command, { cwd: root, env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    return child.stdout.toString().trim()
  }
  try {
    const older = join(root, 'deps/example.org/absl/20250127.2')
    const newer = join(root, 'deps/example.org/absl/20250512.2')
    const regex = join(root, 'deps/example.org/re/2025.11.5')
    const stage = join(root, 'artifact')
    for (const path of [join(older, 'lib'), join(newer, 'lib'), join(regex, 'lib'), join(stage, 'bin')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(root, 'old.c'), 'int absl_old(void) { return 20; }')
    writeFileSync(join(root, 'new.c'), 'int absl_new(void) { return 20; }')
    writeFileSync(join(root, 're.c'), 'extern int absl_old(void); int re(void) { return absl_old() + 1; }')
    writeFileSync(join(root, 'main.c'), '#include <stdio.h>\nextern int absl_new(void); extern int re(void); int main(void) { printf("%d\\n", absl_new() + re() + 1); return 0; }')
    const dylib = (source: string, output: string, id: string, ...extra: string[]) =>
      run(['xcrun', 'clang', '-dynamiclib', join(root, source), ...extra, '-Wl,-headerpad_max_install_names', '-install_name', id, '-o', output])
    dylib('old.c', join(older, 'lib/libfixtureabsl.2501.0.0.dylib'), '@rpath/libfixtureabsl.2501.0.0.dylib')
    symlinkSync('libfixtureabsl.2501.0.0.dylib', join(older, 'lib/libfixtureabsl.dylib'))
    dylib('new.c', join(newer, 'lib/libfixtureabsl.2505.0.0.dylib'), '@rpath/libfixtureabsl.2505.0.0.dylib')
    symlinkSync('libfixtureabsl.2505.0.0.dylib', join(newer, 'lib/libfixtureabsl.dylib'))
    dylib('re.c', join(regex, 'lib/libfixturere.11.dylib'), '@rpath/libfixturere.11.dylib', join(older, 'lib/libfixtureabsl.2501.0.0.dylib'))
    run(['install_name_tool', '-change', '@rpath/libfixtureabsl.2501.0.0.dylib', '@rpath/example.org/absl/v20250127/lib/libfixtureabsl.dylib', join(regex, 'lib/libfixturere.11.dylib')])
    symlinkSync('libfixturere.11.dylib', join(regex, 'lib/libfixturere.dylib'))
    run(['xcrun', 'clang', join(root, 'main.c'), `-L${regex}/lib`, '-lfixturere', join(newer, 'lib/libfixtureabsl.2505.0.0.dylib'), '-Wl,-headerpad_max_install_names', '-o', join(stage, 'bin/fixture')])

    await fixUp(stage, 'darwin-arm64', [], [
      { domain: 'example.org/absl', version: '20250512.2', prefix: newer },
      { domain: 'example.org/re', version: '2025.11.5', prefix: regex },
      { domain: 'example.org/absl', version: '20250127.2', prefix: older },
    ])
    rmSync(join(root, 'deps'), { recursive: true, force: true })
    expect(run([join(stage, 'bin/fixture')])).toBe('42')
    expect(readdirSync(join(stage, 'lib')).filter(name => name.startsWith('libfixtureabsl')).sort()).toEqual(['libfixtureabsl.2501.0.0.dylib', 'libfixtureabsl.2505.0.0.dylib'])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

// php.net on darwin: thrysoee.dk/editline's libedit carries the
// libncursesw.6.dylib it was linked against (tgetent included), and the
// declared ncurses keeps tgetent in libtinfow instead. Taking ncurses' file
// for libedit aborted php in dyld: "Symbol not found: _tgetent".
test.skipIf(process.platform !== 'darwin')('a copied library resolves its needs from its own package first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-link-closure-'))
  const environment = { ...process.env }
  for (const key of ['DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'LD_LIBRARY_PATH', 'LD_PRELOAD']) delete environment[key]
  const run = (command: string[]) => {
    const child = Bun.spawnSync(command, { cwd: root, env: environment, stdout: 'pipe', stderr: 'pipe' })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    return child.stdout.toString().trim()
  }
  try {
    const editline = join(root, 'deps/thrysoee.dk/editline/3.1.0')
    const ncurses = join(root, 'deps/invisible-island.net/ncurses/6.6.0.1')
    const stage = join(root, 'artifact')
    for (const path of [join(editline, 'lib'), join(ncurses, 'lib'), join(stage, 'bin')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(root, 'term-full.c'), 'int fixture_tgetent(void) { return 40; } int fixture_other(void) { return 0; }')
    writeFileSync(join(root, 'term-split.c'), 'int fixture_other(void) { return 0; }')
    writeFileSync(join(root, 'edit.c'), 'extern int fixture_tgetent(void); int edit(void) { return fixture_tgetent() + 2; }')
    writeFileSync(join(root, 'main.c'), '#include <stdio.h>\nextern int edit(void); int main(void) { printf("%d\\n", edit()); return 0; }')
    const dylib = (source: string, output: string, id: string, ...extra: string[]) =>
      run(['xcrun', 'clang', '-dynamiclib', join(root, source), ...extra, '-Wl,-headerpad_max_install_names', '-install_name', id, '-o', output])
    dylib('term-full.c', join(editline, 'lib/libfixturetermw.6.dylib'), '@rpath/libfixturetermw.6.dylib')
    dylib('edit.c', join(editline, 'lib/libfixtureedit.0.dylib'), '@rpath/libfixtureedit.0.dylib', join(editline, 'lib/libfixturetermw.6.dylib'), '-Wl,-rpath,@loader_path')
    symlinkSync('libfixtureedit.0.dylib', join(editline, 'lib/libfixtureedit.dylib'))
    dylib('term-split.c', join(ncurses, 'lib/libfixturetermw.6.dylib'), '@rpath/libfixturetermw.6.dylib')
    symlinkSync('libfixturetermw.6.dylib', join(ncurses, 'lib/libfixturetermw.dylib'))
    run(['xcrun', 'clang', join(root, 'main.c'), `-L${editline}/lib`, '-lfixtureedit', '-Wl,-headerpad_max_install_names', '-o', join(stage, 'bin/fixture')])

    await fixUp(stage, 'darwin-arm64', [], [
      { domain: 'invisible-island.net/ncurses', version: '6.6.0.1', prefix: ncurses },
      { domain: 'thrysoee.dk/editline', version: '3.1.0', prefix: editline },
    ])
    rmSync(join(root, 'deps'), { recursive: true, force: true })
    expect(run([join(stage, 'bin/fixture')])).toBe('42')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
