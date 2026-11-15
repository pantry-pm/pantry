/**
 * **libatomic** - The GNU atomic operations runtime library (libatomic.so.1) on its own, without the compiler
 *
 * @domain `gnu.org/gcc/libatomic`
 * @version `15.2.0` (1 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install gnu.org/gcc/libatomic`
 * @homepage https://gcc.gnu.org/wiki/Atomic
 * @buildDependencies `gnu.org/gcc`, `gnu.org/make` - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.gnuorggcc
 * console.log(pkg.name)        // "libatomic"
 * console.log(pkg.description) // "The GNU atomic operations runtime library (liba..."
 * console.log(pkg.versions[0]) // "15.2.0" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/gnu-org/gcc/libatomic.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const gnuorggcclibatomicPackage = {
  /**
  * The display name of this package.
  */
  name: 'libatomic' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'gnu.org/gcc/libatomic' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'The GNU atomic operations runtime library (libatomic.so.1) on its own, without the compiler' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://gcc.gnu.org/wiki/Atomic' as const,
  githubUrl: '' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install gnu.org/gcc/libatomic' as const,
  pantryInstallCommand: 'pantry install gnu.org/gcc/libatomic' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'gnu.org/gcc',
    'gnu.org/make',
  ] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '15.2.0',
  ] as const,
  aliases: [] as const,
}

export type GnuorggcclibatomicPackage = typeof gnuorggcclibatomicPackage
