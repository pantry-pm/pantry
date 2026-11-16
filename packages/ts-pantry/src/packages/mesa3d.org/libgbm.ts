/**
 * **libgbm** - Mesa Generic Buffer Management client library
 *
 * @domain `mesa3d.org/libgbm`
 * @version `26.0.6` (1 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install mesa3d.org/libgbm`
 * @homepage https://www.mesa3d.org/
 * @dependencies `dri.freedesktop.org^2.4.110`, `libexpat.github.io^2`, `systemd.io/libudev^262`
 * @buildDependencies `python.org~3.11`, `ninja-build.org`, `freedesktop.org/pkg-config^0.29`, ... (+3 more) - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.mesa3dorglibgbm
 * console.log(pkg.name)        // "libgbm"
 * console.log(pkg.description) // "Mesa Generic Buffer Management client library"
 * console.log(pkg.versions[0]) // "26.0.6" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/mesa3d-org/libgbm.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const mesa3dorglibgbmPackage = {
  /**
  * The display name of this package.
  */
  name: 'libgbm' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'mesa3d.org/libgbm' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'Mesa Generic Buffer Management client library' as const,
  homepageUrl: 'https://www.mesa3d.org/' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install mesa3d.org/libgbm' as const,
  pantryInstallCommand: 'pantry install mesa3d.org/libgbm' as const,
  programs: [] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  */
  dependencies: [
    'dri.freedesktop.org^2.4.110',
    'libexpat.github.io^2',
    'systemd.io/libudev^262',
  ] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'python.org~3.11',
    'ninja-build.org',
    'freedesktop.org/pkg-config^0.29',
    'gnu.org/coreutils',
    'gnu.org/binutils',
    'bun.com^1.3',
  ] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '26.0.6',
  ] as const,
  aliases: [] as const,
  runtimeEnvironment: undefined,
}

export type Mesa3dorglibgbmPackage = typeof mesa3dorglibgbmPackage
