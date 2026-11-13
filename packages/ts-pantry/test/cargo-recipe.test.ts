import { expect, test } from 'bun:test'
import { loadRecipe } from '../scripts/recipe-loader'
import { resolveVersionedBuildDependencyGraph, versionSatisfies } from '../scripts/build-package'
import { rustlangorgcargoPackage as cargoPackage } from '../src/packages/rust-lang.org/cargo'

// Upstream Cargo.lock pins libgit2-sys with the native ABI in its version:
// 0.81: 0.16.2+1.7.2, 0.82: 0.17.0+1.8.1, 0.87: 0.18.0+1.9.0.
for (const platform of ['linux-arm64', 'linux-x86-64', 'darwin-arm64']) {
  test(`Cargo's published dependency graph selects its real libgit2 ABI on ${platform}`, async () => {
    const graph = await resolveVersionedBuildDependencyGraph(
      new Map([['rust-lang.org/cargo', 'rust-lang.org/cargo =0.95.0']]), platform,
      async domain => ({ versions: Object.fromEntries(
        (domain === 'rust-lang.org/cargo' ? ['0.95.0'] : domain === 'libgit2.org' ? ['1.7.2', '1.8.1', '1.9.2'] : domain === 'curl.se' ? ['8.23.0'] : ['1.0.0'])
          .map(version => [version, { platforms: { [platform]: {} } }]),
      ) }),
      async (domain, version) => domain === 'rust-lang.org/cargo' ? (await loadRecipe(domain, platform, version)).recipe : {},
    )
    expect(graph.get('libgit2.org')).toBe('libgit2.org ~1.9')
    const loaded = await loadRecipe('rust-lang.org/cargo', platform, '0.95.0')
    const constraint = loaded.recipe.dependencies!['libgit2.org'] as string
    expect(versionSatisfies('1.9.2', constraint)).toBe(true)
    expect(versionSatisfies('1.7.2', constraint)).toBe(false)
    expect(versionSatisfies('1.10.0', constraint)).toBe(false)
  })

  test(`Cargo's historical ABI boundaries remain version specific on ${platform}`, async () => {
    for (const [version, abi] of [['0.75.0', '~1.7'], ['0.81.0', '~1.7'], ['0.82.0', '~1.8'], ['0.86.0', '~1.8'], ['0.87.0', '~1.9'], ['0.95.0', '~1.9']]) {
      const loaded = await loadRecipe('rust-lang.org/cargo', platform, version)
      expect(loaded.recipe.dependencies!['libgit2.org']).toBe(abi)
    }
  })
}

test('Cargo installer metadata uses the current ABI and the source compiler meets its MSRV', async () => {
  expect(cargoPackage.dependencies).toContain('libgit2.org~1.9')
  const loaded = await loadRecipe('rust-lang.org/cargo', 'linux-arm64', '0.95.0')
  const rust = loaded.recipe.build!.dependencies!['rust-lang.org'] as string
  expect(versionSatisfies('1.89.0', rust)).toBe(true)
  expect(versionSatisfies('1.88.0', rust)).toBe(false)
})
