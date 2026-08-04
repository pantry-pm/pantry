/**
 * **mysql** - MySQL Server, the world's most popular open source database, and MySQL Cluster, a real-time, open source transactional database.
 *
 * @domain `mysql.com`
 * @programs `my_print_defaults`, `myisam_ftdump`, `myisamchk`, `myisamlog`, `myisampack`, ... (+17 more)
 * @version `8.0.45` (3 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install mysql.com`
 * @name `mysql`
 * @homepage http://www.mysql.com/
 * @dependencies `unicode.org^71`, `libevent.org^2`, `lz4.org^1`, ... (+8 more) (includes OS-specific dependencies with `os:package` format)
 * @buildDependencies `cmake.org@^3`, `gnu.org/bison@>=3.0.4`, `linux:gnu.org/gcc` (includes OS-specific dependencies with `os:package` format) - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * // Access the package
 * const pkg = pantry.mysql
 * // Or access via domain
 * const samePkg = pantry.mysqlcom
 * console.log(pkg === samePkg) // true
 * console.log(pkg.name)        // "mysql"
 * console.log(pkg.description) // "MySQL Server, the world's most popular open sou..."
 * console.log(pkg.programs)    // ["my_print_defaults", "myisam_ftdump", ...]
 * console.log(pkg.versions[0]) // "8.0.43" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/mysql-com.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const mysqlPackage = {
  /**
  * The display name of this package.
  */
  name: 'mysql' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'mysql.com' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'MySQL Server, the world\'s most popular open source database, and MySQL Cluster, a real-time, open source transactional database.' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/mysql.com/package.yml' as const,
  homepageUrl: 'http://www.mysql.com/' as const,
  githubUrl: 'https://github.com/mysql/mysql-server' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install mysql.com' as const,
  pantryInstallCommand: 'pantry install mysql.com' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'my_print_defaults',
    'myisam_ftdump',
    'myisamchk',
    'myisamlog',
    'myisampack',
    'mysql',
    'mysql_config',
    'mysql_config_editor',
    'mysql_migrate_keyring',
    'mysql_secure_installation',
    'mysql_tzinfo_to_sql',
    'mysqladmin',
    'mysqlbinlog',
    'mysqlcheck',
    'mysqld',
    'mysqld_multi',
    'mysqld_safe',
    'mysqldump',
    'mysqldumpslow',
    'mysqlimport',
    'mysqlshow',
    'mysqlslap',
    ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  * OS-specific dependencies are prefixed with `os:` (e.g., `linux:freetype.org`).
  */
  dependencies: [
    'libevent.org^2',
    'lz4.org^1',
    'openssl.org^3',
    'zlib.net^1.2',
    'facebook.com/zstd^1',
    'curl.se>=6.0',
    'thrysoee.dk/editline^3',
    'developers.yubico.com/libfido2^1',
    'linux:sourceforge.net/libtirpc',
    'linux:gnu.org/gcc/libstdcxx@14',
  ] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  * OS-specific dependencies are prefixed with `os:` (e.g., `linux:gnu.org/gcc`).
  */
  buildDependencies: [
    'cmake.org@^3',
    'gnu.org/bison@>=3.0.4',
    'linux:gnu.org/gcc',
  ] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '8.0.45',
    '8.0.44',
    '8.0.43',
  ] as const,
  /**
  * Alternative names for this package.
  * You can use any of these names to access the package.
  */
  aliases: [] as const,
}

export type MysqlPackage = typeof mysqlPackage
