/**
 * **stacks-bun** - Bun with MySQL and Postgres calls that answer where they are written: query.wait(), executeSync(), cancelSync() and sql.reserveSync(). Official Bun plus those changes, built by stacksjs/bun.
 *
 * @domain `stacksjs.com/bun`
 * @programs `bun`, `bunx`
 * @version `1.4.4.3` (3 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install stacksjs.com/bun`
 * @homepage https://github.com/stacksjs/bun#readme
 * @buildDependencies `curl.se`, `info-zip.org/unzip`, `gnu.org/coreutils` - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.stacksjscombun
 * console.log(pkg.name)        // "stacks-bun"
 * console.log(pkg.description) // "Bun with MySQL and Postgres calls that answer w..."
 * console.log(pkg.programs)    // ["bun", "bunx"]
 * console.log(pkg.versions[0]) // "1.4.4.3" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/stacksjs-com/bun.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const stacksjscombunPackage = {
  /**
  * The display name of this package.
  */
  name: 'stacks-bun' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'stacksjs.com/bun' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'Bun with MySQL and Postgres calls that answer where they are written: query.wait(), executeSync(), cancelSync() and sql.reserveSync(). Official Bun plus those changes, built by stacksjs/bun.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://github.com/stacksjs/bun#readme' as const,
  githubUrl: 'https://github.com/stacksjs/bun' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install stacksjs.com/bun' as const,
  pantryInstallCommand: 'pantry install stacksjs.com/bun' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'bun',
    'bunx',
  ] as const,
  companions: [] as const,
  dependencies: [] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'curl.se',
    'info-zip.org/unzip',
    'gnu.org/coreutils',
  ] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '1.4.4.3',
    '1.4.4.2',
    '1.4.4.1',
  ] as const,
  aliases: [] as const,
}

export type StacksjscombunPackage = typeof stacksjscombunPackage
