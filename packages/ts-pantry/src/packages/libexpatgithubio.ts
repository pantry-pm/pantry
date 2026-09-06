/**
 * **xmlwf** - :herb: Fast streaming XML parser written in C99 with >90% test coverage; moved from SourceForge to GitHub
 *
 * @domain `libexpat.github.io`
 * @programs `xmlwf`
 * @version `2.8.4` (50 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install libexpat.github.io`
 * @homepage https://libexpat.github.io/
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.libexpatgithubio
 * console.log(pkg.name)        // "xmlwf"
 * console.log(pkg.description) // ":herb: Fast streaming XML parser written in C99..."
 * console.log(pkg.programs)    // ["xmlwf"]
 * console.log(pkg.versions[0]) // "2.8.4" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/libexpat-github-io.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const libexpatgithubioPackage = {
  /**
  * The display name of this package.
  */
  name: 'xmlwf' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'libexpat.github.io' as const,
  /**
  * Brief description of what this package does.
  */
  description: ':herb: Fast streaming XML parser written in C99 with >90% test coverage; moved from SourceForge to GitHub' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/libexpat.github.io/package.yml' as const,
  homepageUrl: 'https://libexpat.github.io/' as const,
  githubUrl: 'https://github.com/libexpat/libexpat' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install libexpat.github.io' as const,
  pantryInstallCommand: 'pantry install libexpat.github.io' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'xmlwf',
  ] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '2.8.4',
    '2.8.3',
    '2.8.2',
    '2.8.1',
    '2.8.0',
    '2.7.5',
    '2.7.4',
    '2.7.3',
    '2.7.2',
    '2.7.1',
    '2.7.0',
    '2.6.4',
    '2.6.3',
    '2.6.2',
    '2.6.1',
    '2.6.0',
    '2.5.0',
    '2.4.9',
    '2.4.8',
    '2.4.7',
    '2.4.6',
    '2.4.5',
    '2.4.4',
    '2.4.3',
    '2.4.2',
    '2.4.1',
    '2.4.0',
    '2.3.0',
    '2.2.10',
    '2.2.9',
    '2.2.8',
    '2.2.7',
    '2.2.6',
    '2.2.5',
    '2.2.4',
    '2.2.3',
    '2.2.2',
    '2.2.1',
    '2.2.0',
    '2.1.1',
    '2.1.0',
    '2.0.1',
    '2.0.0',
    '1.95.8',
    '1.95.7',
    '1.95.6',
    '1.95.5',
    '1.95.4',
    '1.95.3',
    '1.95.2',
  ] as const,
  aliases: [] as const,
}

export type LibexpatgithubioPackage = typeof libexpatgithubioPackage
