import { expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fixUp } from '../scripts/fix-up'

// Public fixUp plus a native relocated subprocess catches helper-only loader
// edges and finalized resource bytes; it does not qualify any WebKit host.
for (const resourceDirectory of ['libexec/provider', 'share/provider']) {
  test.skipIf(!['darwin', 'linux'].includes(process.platform))(`copied native runtime helpers in ${resourceDirectory} keep their own declared libraries and resources after relocation`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'pantry native helper '))
    const darwin = process.platform === 'darwin'
    const platform = `${darwin ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x86-64'}`
    const environment = { ...process.env }
    for (const key of ['DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'LD_LIBRARY_PATH', 'LD_PRELOAD']) delete environment[key]
    const compiler: string[] = darwin ? ['xcrun', 'clang'] : process.env.PANTRY_TEST_CC ? JSON.parse(process.env.PANTRY_TEST_CC) : ['cc']
    const run = (command: string[]) => {
      const child = Bun.spawnSync(command, { cwd: root, env: environment, stdout: 'pipe', stderr: 'pipe' })
      expect(child.exitCode, child.stderr.toString()).toBe(0)
      return child.stdout.toString().trim()
    }
    const hash = (file: string) => new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex')
    try {
      const provider = join(root, 'dependencies/provider')
      const helperLibrary = join(root, 'dependencies/helper-library')
      const stage = join(root, 'artifact')
      for (const path of [join(provider, 'lib'), join(provider, resourceDirectory), join(helperLibrary, 'lib64'), join(stage, 'bin')]) mkdirSync(path, { recursive: true })
      writeFileSync(join(provider, 'LICENSE'), 'Provider fixture license\n')
      writeFileSync(join(helperLibrary, 'COPYING'), 'Helper library fixture license\n')
      writeFileSync(join(provider, `${resourceDirectory}/message.txt`), 'owned helper resource\n')
      writeFileSync(join(root, 'provider.c'), 'int provider(void) { return 7; }')
      writeFileSync(join(root, 'helper-library.c'), 'int helper_value(void) { return 42; }')
      writeFileSync(join(root, 'main.c'), '#include <stdio.h>\nextern int provider(void); int main(void) { printf("%d\\n", provider()); return 0; }')
      writeFileSync(join(root, 'helper.c'), `#include <stdio.h>
  #include <stdlib.h>
  #include <string.h>
  #include <limits.h>
  extern int helper_value(void);
  int main(int argc, char **argv) {
    char path[PATH_MAX], message[128];
    if (argc != 1 || !realpath(argv[0], path)) return 2;
    char *name = strrchr(path, '/');
    if (!name || (size_t)(name - path) + sizeof("/message.txt") > sizeof(path)) return 3;
    strcpy(name, "/message.txt");
    FILE *resource = fopen(path, "r");
    if (!resource) return 4;
    if (!fgets(message, sizeof(message), resource)) { fclose(resource); return 5; }
    if (fclose(resource)) return 6;
    printf("%d:%s", helper_value(), message);
    return 0;
  }`)
      const libraryName = darwin ? 'libfixture-provider.1.dylib' : 'libfixture-provider.so.1'
      const helperLibraryName = darwin ? 'libfixture-helper-only.1.dylib' : 'libfixture-helper-only.so.1'
      const library = join(provider, 'lib', libraryName)
      const helperDependency = join(helperLibrary, 'lib64', helperLibraryName)
      const helper = join(provider, `${resourceDirectory}/helper`)
      const shared = (source: string, name: string, output: string) => run([...compiler, darwin ? '-dynamiclib' : '-shared', '-fPIC', source, ...(darwin ? ['-Wl,-headerpad_max_install_names', '-install_name', `@rpath/${name}`] : [`-Wl,-soname,${name}`]), '-o', output])
      shared(join(root, 'provider.c'), libraryName, library)
      shared(join(root, 'helper-library.c'), helperLibraryName, helperDependency)
      run([...compiler, join(root, 'helper.c'), helperDependency, `-Wl,-rpath,${helperLibrary}/lib64`, ...(darwin ? ['-Wl,-headerpad_max_install_names'] : []), '-o', helper])
      run([...compiler, join(root, 'main.c'), library, `-Wl,-rpath,${provider}/lib`, ...(darwin ? ['-Wl,-headerpad_max_install_names'] : []), '-o', join(stage, 'bin/application')])
      expect(run([join(stage, 'bin/application')])).toBe('7')
      expect(run([helper])).toBe('42:owned helper resource')
      chmodSync(helper, 0o555)
      const incomplete = join(root, 'incomplete')
      cpSync(stage, incomplete, { recursive: true })
      await expect(fixUp(incomplete, platform, [], [
        { domain: 'provider.example', version: '1.0', prefix: provider, resources: [resourceDirectory] },
      ])).rejects.toThrow(helperLibraryName)
      expect(statSync(join(incomplete, resourceDirectory, 'helper')).mode & 0o777).toBe(0o555)
      rmSync(incomplete, { recursive: true })
      await fixUp(stage, platform, [], [
        { domain: 'provider.example', version: '1.0', prefix: provider, resources: [resourceDirectory] },
        { domain: 'helper-library.example', version: '1.0', prefix: helperLibrary },
      ])
      const manifest = join(stage, 'share/pantry/runtime-libraries.json')
      const beforeRepeat = [hash(join(stage, `${resourceDirectory}/helper`)), hash(manifest)]
      await fixUp(stage, platform, [], [
        { domain: 'provider.example', version: '1.0', prefix: provider, resources: [resourceDirectory] },
        { domain: 'helper-library.example', version: '1.0', prefix: helperLibrary },
      ])
      expect([hash(join(stage, `${resourceDirectory}/helper`)), hash(manifest)]).toEqual(beforeRepeat)
      const fresh = join(root, 'fresh consumer/pantry/application.example/v1.0')
      mkdirSync(dirname(fresh), { recursive: true })
      renameSync(stage, fresh)
      rmSync(join(root, 'dependencies'), { recursive: true })
      for (const source of ['provider.c', 'helper-library.c', 'main.c', 'helper.c']) rmSync(join(root, source))
      expect(run([join(fresh, 'bin/application')])).toBe('7')
      const relocated = run([join(fresh, `${resourceDirectory}/helper`)])
      expect(relocated).toBe('42:owned helper resource')
      expect(statSync(join(fresh, `${resourceDirectory}/helper`)).mode & 0o777).toBe(0o555)
      const provenance = JSON.parse(readFileSync(join(fresh, 'share/pantry/runtime-libraries.json'), 'utf8'))
      expect(provenance.libraries.map((entry: { domain: string }) => entry.domain).sort()).toEqual(['helper-library.example', 'provider.example'])
      const resources = provenance.libraries.find((entry: { domain: string }) => entry.domain === 'provider.example').resources
      expect(resources.map((entry: { path: string }) => entry.path)).toEqual([`${resourceDirectory}/helper`, `${resourceDirectory}/message.txt`])
      for (const resource of resources) expect(resource.sha256).toBe(hash(join(fresh, resource.path)))
      if (darwin) run(['codesign', '--verify', '--strict', join(fresh, `${resourceDirectory}/helper`)])
      console.info(JSON.stringify({ nativeHelperRelocation: { platform, resourceDirectory, sourceRootsRemoved: true, application: '7', helper: relocated, resourceHashes: resources } }))
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)
}
