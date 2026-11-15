import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

/**
 * Discover module directories only inside checksummed, declared dependencies.
 *
 * An interpreter's own `site-packages` is left out. That interpreter already
 * has it on `sys.path`, so listing it adds nothing there, while PYTHONPATH
 * outranks a virtual environment's own `site-packages` and so puts the base
 * interpreter's pip and setuptools in front of whatever a venv built on it
 * installs. `pip install --upgrade pip` inside such a venv then rewrites
 * `venv/bin/pip` for the new pip but keeps importing the old one: with pip
 * 26.3, whose launcher imports a name older pips lack, every `python-venv.sh`
 * and `bkpyvenv` build died on `cannot import name 'cli'`.
 */
export function dependencyPythonPaths(prefixes: readonly string[]): string[] {
  const result = new Set<string>()
  for (const prefix of new Set(prefixes)) {
    const root = realpathSync(prefix)
    const owned = (file: string): string => {
      const actual = realpathSync(file)
      const local = relative(root, actual)
      if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
        throw new Error(`Python module directory escapes its declared package: ${file}`)
      return actual
    }
    for (const directory of ['lib', 'lib64', 'venv/lib', 'venv/lib64']) {
      const library = join(root, directory)
      if (!existsSync(library)) continue
      for (const name of readdirSync(owned(library)).sort()) {
        if (!/^python\d+(?:\.\d+)?$/.test(name)) continue
        // The standard library sits beside site-packages only in the
        // interpreter's own tree; a library package or a venv has none.
        if (existsSync(join(library, name, 'os.py'))) continue
        for (const folder of ['site-packages', 'dist-packages']) {
          const candidate = join(library, name, folder)
          if (existsSync(candidate) && statSync(candidate).isDirectory()) result.add(owned(candidate))
        }
      }
    }
  }
  return [...result]
}
