/**
 * **kluctl** - The missing glue to put together large Kubernetes deployments, composed of multiple smaller parts (Helm/Kustomize/...)  in a manageable and unified way.
 *
 * @domain `kluctl.io`
 * @programs `kluctl`
 * @version `2.28.2` (49 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install kluctl.io`
 * @homepage https://kluctl.io
 * @buildDependencies `go.dev@^1.21`, `nodejs.org@^18`, `npmjs.com`, ... (+1 more) - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.kluctlio
 * console.log(pkg.name)        // "kluctl"
 * console.log(pkg.description) // "The missing glue to put together large Kubernet..."
 * console.log(pkg.programs)    // ["kluctl"]
 * console.log(pkg.versions[0]) // "2.28.2" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/kluctl-io.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const kluctlioPackage = {
  /**
  * The display name of this package.
  */
  name: 'kluctl' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'kluctl.io' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'The missing glue to put together large Kubernetes deployments, composed of multiple smaller parts (Helm/Kustomize/...)  in a manageable and unified way.' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/kluctl.io/package.yml' as const,
  homepageUrl: 'https://kluctl.io' as const,
  githubUrl: 'https://github.com/kluctl/kluctl' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install kluctl.io' as const,
  pantryInstallCommand: 'pantry install kluctl.io' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'kluctl',
  ] as const,
  companions: [] as const,
  dependencies: [] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'go.dev@^1.21',
    'nodejs.org@^18',
    'npmjs.com',
    'gnu.org/make',
  ] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '2.28.2',
    '2.28.1',
    '2.27.0',
    '2.26.0',
    '2.25.1',
    '2.25.0',
    '2.24.1',
    '2.24.0',
    '2.23.5',
    '2.23.4',
    '2.23.3',
    '2.23.2',
    '2.23.1',
    '2.23.0',
    '2.22.1',
    '2.22.0',
    '2.21.2',
    '2.21.1',
    '2.21.0',
    '2.20.8',
    '2.20.7',
    '2.20.6',
    '2.20.4',
    '2.20.3',
    '2.20.2',
    '2.20.1',
    '2.19.4',
    '2.19.3',
    '2.19.2',
    '2.19.1',
    '2.19.0',
    '2.18.4',
    '2.18.3',
    '2.18.2',
    '2.18.1',
    '2.18.0',
    '2.17.1',
    '2.17.0',
    '2.16.1',
    '2.16.0',
    '2.15.0',
    '2.14.1',
    '2.13.1',
    '2.13.0',
    '2.12.7',
    '2.12.6',
    '2.12.5',
    '2.12.4',
    '2.12.3',
  ] as const,
  aliases: [] as const,
}

export type KluctlioPackage = typeof kluctlioPackage
