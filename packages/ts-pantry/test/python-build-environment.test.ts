import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dependencyPythonPaths } from '../scripts/python-build-environment'

test('declared Python modules include regular and private venv layouts without duplicate aliases', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pantry-python-modules-')))
  try {
    const plain = join(root, 'lib/python3.12/site-packages')
    const venv = join(root, 'venv/lib/python3.13/site-packages')
    mkdirSync(plain, { recursive: true })
    mkdirSync(venv, { recursive: true })
    symlinkSync('python3.12', join(root, 'lib/python3'))
    expect(dependencyPythonPaths([root, root])).toEqual([plain, venv])
    const outside = mkdtempSync(join(tmpdir(), 'pantry-foreign-python-'))
    try {
      symlinkSync(outside, join(root, 'lib/python3.14'))
      mkdirSync(join(outside, 'site-packages'))
      expect(() => dependencyPythonPaths([root])).toThrow('escapes its declared package')
    }
    finally { rmSync(outside, { recursive: true, force: true }) }
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('an interpreter\'s own site-packages stays off PYTHONPATH so a venv keeps its own pip', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pantry-python-interpreter-')))
  try {
    // python.org: the standard library and site-packages (pip, setuptools) share lib/python3.11.
    const interpreter = join(root, 'python.org')
    mkdirSync(join(interpreter, 'lib/python3.11/site-packages/pip'), { recursive: true })
    writeFileSync(join(interpreter, 'lib/python3.11/os.py'), '')
    // A library package and a venv-packaged tool carry modules but no standard library.
    const library = join(root, 'library/lib/python3.11/site-packages')
    const tool = join(root, 'tool/venv/lib/python3.11/site-packages')
    mkdirSync(library, { recursive: true })
    mkdirSync(tool, { recursive: true })
    expect(dependencyPythonPaths([interpreter, join(root, 'library'), join(root, 'tool')])).toEqual([library, tool])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
