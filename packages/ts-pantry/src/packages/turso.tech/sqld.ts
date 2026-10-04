/**
 * **libsql-server** (`sqld`) - libSQL server: the database server behind Turso and `turso dev`.
 *
 * @domain `turso.tech/sqld`
 * @programs `sqld`
 * @version `0.24.32` (51 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install turso.tech/sqld`
 * @name `libsql-server`
 * @homepage https://github.com/tursodatabase/libsql/tree/main/libsql-server
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.tursotechsqld
 * console.log(pkg.name)        // "libsql-server"
 * console.log(pkg.versions[0]) // "0.24.32" (latest)
 * ```
 */
export const tursotechsqldPackage = {
  /**
  * The display name of this package.
  */
  name: 'libsql-server' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'turso.tech/sqld' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'libSQL server: the database server behind Turso and `turso dev`.' as const,
  // First-party: not mirrored from pkgx; the recipe lives in this repository. `turso dev` runs it.
  packageYmlUrl: 'https://github.com/pantry-pm/pantry/tree/main/packages/ts-pantry/src/recipes/turso.tech/sqld.ts' as const,
  homepageUrl: 'https://github.com/tursodatabase/libsql/tree/main/libsql-server' as const,
  githubUrl: 'https://github.com/tursodatabase/libsql' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install turso.tech/sqld' as const,
  pantryInstallCommand: 'pantry install turso.tech/sqld' as const,
  /**
  * Executable programs provided by this package.
  */
  programs: [
    'sqld',
  ] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: [] as const,
  /**
  * Available versions from newest to oldest.
  */
  versions: [
    '0.24.32',
    '0.24.31',
    '0.24.30',
    '0.24.29',
    '0.24.28',
    '0.24.27',
    '0.24.26',
    '0.24.25',
    '0.24.24',
    '0.24.23',
    '0.24.22',
    '0.24.21',
    '0.24.20',
    '0.24.18',
    '0.24.17',
    '0.24.16',
    '0.24.15',
    '0.24.14',
    '0.24.13',
    '0.24.12',
    '0.24.11',
    '0.24.10',
    '0.24.9',
    '0.24.8',
    '0.24.5',
    '0.24.4',
    '0.24.2',
    '0.23.7',
    '0.23.6',
    '0.23.5',
    '0.23.4',
    '0.23.3',
    '0.23.2',
    '0.23.1',
    '0.23.0',
    '0.22.22',
    '0.22.21',
    '0.22.20',
    '0.22.19',
    '0.22.18',
    '0.22.17',
    '0.22.16',
    '0.22.15',
    '0.22.14',
    '0.22.13',
    '0.22.12',
    '0.22.11',
    '0.22.10',
    '0.22.9',
    '0.22.8',
    '0.22.7',
  ] as const,
  /**
  * Alternative names for this package.
  */
  aliases: [
    'libsql-server',
  ] as const,
}

export type TursotechsqldPackage = typeof tursotechsqldPackage
