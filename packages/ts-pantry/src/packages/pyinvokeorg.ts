/**
 * **invoke** - Pythonic task management & command execution.
 *
 * @domain `pyinvoke.org`
 * @programs `invoke`
 * @version `3.0.3` (70 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install pyinvoke.org`
 * @homepage https://www.pyinvoke.org/
 * @dependencies `pkgx.sh>=1`
 * @buildDependencies `python.org@^3.13.3` - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.pyinvokeorg
 * console.log(pkg.name)        // "invoke"
 * console.log(pkg.description) // "Pythonic task management & command execution."
 * console.log(pkg.programs)    // ["invoke"]
 * console.log(pkg.versions[0]) // "3.0.3" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/pyinvoke-org.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const pyinvokeorgPackage = {
  /**
  * The display name of this package.
  */
  name: 'invoke' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'pyinvoke.org' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'Pythonic task management & command execution.' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/pyinvoke.org/package.yml' as const,
  homepageUrl: 'https://www.pyinvoke.org/' as const,
  githubUrl: 'https://github.com/pyinvoke/invoke' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install pyinvoke.org' as const,
  pantryInstallCommand: 'pantry install pyinvoke.org' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'invoke',
  ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  */
  dependencies: [
    'pkgx.sh>=1',
  ] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'python.org@^3.13.3',
  ] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '3.0.3',
    '3.0.2',
    '3.0.1',
    '3.0.0',
    '2.2.1',
    '2.2.0',
    '2.1.4',
    '2.1.3',
    '2.1.2',
    '2.1.1',
    '2.1.0',
    '2.0.1',
    '2.0.0',
    '1.7.3',
    '1.7.2',
    '1.7.1',
    '1.7.0',
    '1.6.0',
    '1.5.1',
    '1.5.0',
    '1.4.1',
    '1.4.0',
    '1.3.1',
    '1.3.0',
    '1.2.0',
    '1.1.1',
    '1.1.0',
    '1.0.2',
    '1.0.1',
    '1.0.0',
    '0.23.0',
    '0.22.1',
    '0.22.0',
    '0.21.0',
    '0.20.4',
    '0.20.3',
    '0.20.2',
    '0.20.1',
    '0.20.0',
    '0.19.0',
    '0.18.1',
    '0.18.0',
    '0.17.0',
    '0.16.3',
    '0.16.2',
    '0.16.1',
    '0.16.0',
    '0.15.0',
    '0.14.0',
    '0.13.0',
    '0.12.2',
    '0.12.1',
    '0.12.0',
    '0.11.1',
    '0.11.0',
    '0.10.1',
    '0.10.0',
    '0.9.0',
    '0.8.2',
    '0.8.1',
    '0.8.0',
    '0.7.0',
    '0.6.1',
    '0.6.0',
    '0.5.1',
    '0.5.0',
    '0.4.0',
    '0.3.0',
    '0.2.0',
    '0.1.0',
  ] as const,
  aliases: [] as const,
}

export type PyinvokeorgPackage = typeof pyinvokeorgPackage
