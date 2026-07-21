import { describe, expect, test } from 'bun:test'
import type { PackageRecipe } from '../scripts/buildkit'
import { generateBuildScript } from '../scripts/buildkit'
import { recipe as awsCliRecipe } from '../src/recipes/aws.amazon.com/cli'

describe('Python-backed package runtime wrappers', () => {
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
})
