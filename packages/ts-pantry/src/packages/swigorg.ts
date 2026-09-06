/**
 * **swig** - SWIG is a software development tool that connects programs written in C and C++ with a variety of high-level programming languages.
 *
 * @domain `swig.org`
 * @programs `swig`, `ccache-swig`
 * @version `4.5.1` (50 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install swig.org`
 * @homepage https://www.swig.org/
 * @dependencies `pcre.org/v2`
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.swigorg
 * console.log(pkg.name)        // "swig"
 * console.log(pkg.description) // "SWIG is a software development tool that connec..."
 * console.log(pkg.programs)    // ["swig", "ccache-swig"]
 * console.log(pkg.versions[0]) // "4.5.1" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/swig-org.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const swigorgPackage = {
  /**
  * The display name of this package.
  */
  name: 'swig' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'swig.org' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'SWIG is a software development tool that connects programs written in C and C++ with a variety of high-level programming languages.' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/swig.org/package.yml' as const,
  homepageUrl: 'https://www.swig.org/' as const,
  githubUrl: 'https://github.com/swig/swig' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install swig.org' as const,
  pantryInstallCommand: 'pantry install swig.org' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'swig',
    'ccache-swig',
  ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  */
  dependencies: [
    'pcre.org/v2',
  ] as const,
  buildDependencies: [] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '4.5.1',
    '4.5.0',
    '4.4.1',
    '4.4.0',
    '4.3.1',
    '4.3.0',
    '4.3.0-beta1',
    '4.2.1',
    '4.2.0',
    '4.2.0-beta1',
    '4.1.1',
    '4.1.0',
    '4.1.0-beta1',
    '4.0.2',
    '4.0.1',
    '4.0.0',
    '4.0.0-beta1',
    '3.0.12',
    '3.0.11',
    '3.0.10',
    '3.0.9',
    '3.0.8',
    '3.0.7',
    '3.0.6',
    '3.0.5',
    '3.0.4',
    '3.0.3',
    '3.0.2',
    '3.0.1',
    '3.0.0',
    '3.0.0-beta1',
    '2.0.12',
    '2.0.11',
    '2.0.10',
    '2.0.9',
    '2.0.8',
    '2.0.7',
    '2.0.6',
    '2.0.5',
    '2.0.4',
    '2.0.3',
    '2.0.2',
    '2.0.1',
    '2.0.0',
    '1.3.40',
    '1.3.39',
    '1.3.38',
    '1.3.37',
    '1.3.36',
    '1.3.35',
  ] as const,
  aliases: [] as const,
}

export type SwigorgPackage = typeof swigorgPackage
