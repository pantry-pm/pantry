/**
 * **ack** - ack is a grep-like search tool optimized for source code.
 *
 * @domain `beyondgrep.com`
 * @programs `ack`
 * @version `3.10.0` (49 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install beyondgrep.com`
 * @homepage https://beyondgrep.com/
 * @dependencies `perl.org`
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.beyondgrepcom
 * console.log(pkg.name)        // "ack"
 * console.log(pkg.description) // "ack is a grep-like search tool optimized for so..."
 * console.log(pkg.programs)    // ["ack"]
 * console.log(pkg.versions[0]) // "3.10.0" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/beyondgrep-com.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const beyondgrepcomPackage = {
  /**
  * The display name of this package.
  */
  name: 'ack' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'beyondgrep.com' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'ack is a grep-like search tool optimized for source code.' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/beyondgrep.com/package.yml' as const,
  homepageUrl: 'https://beyondgrep.com/' as const,
  githubUrl: 'https://github.com/beyondgrep/ack3' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install beyondgrep.com' as const,
  pantryInstallCommand: 'pantry install beyondgrep.com' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'ack',
  ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  */
  dependencies: [
    'perl.org',
  ] as const,
  buildDependencies: [] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '3.10.0',
    '3.9.0',
    '3.8.2',
    '3.8.1',
    '3.8.0',
    '3.7.0',
    '3.6.0',
    '3.5.0',
    '3.4.0',
    '3.3.1',
    '3.3.0',
    '3.2.0',
    '3.1.3',
    '3.1.2',
    '3.1.1',
    '3.1.0',
    '3.0.3',
    '3.0.2',
    '3.0.1',
    '3.0.0',
    '2.999_08',
    '2.999_07',
    '2.999_06',
    '2.999_05',
    '2.999_04',
    '2.999_03',
    '2.999_02',
    '2.999_01',
    '2.19_01',
    '2.18',
    '2.17_02',
    '2.17_01',
    '2.16',
    '2.15_03',
    '2.15_02',
    '2.15_01',
    '2.14',
    '2.13_06',
    '2.13_05',
    '2.13_04',
    '2.13_03',
    '2.13_02',
    '2.13_01',
    '2.12',
    '2.11_02',
    '2.11_01',
    '2.10',
    '2.09_03',
    '2.09_02',
  ] as const,
  aliases: [] as const,
}

export type BeyondgrepcomPackage = typeof beyondgrepcomPackage
