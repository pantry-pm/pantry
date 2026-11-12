/**
 * **dtsx-native** - High-performance .d.ts emitter for TypeScript, written in Zig. The standalone CLI is distributed separately from the zig-dtsx JavaScript FFI package.
 *
 * @domain `zig-dtsx.stacksjs.org`
 * @programs `zig-dtsx`
 * @version `0.11.52` (1 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install zig-dtsx.stacksjs.org`
 * @homepage https://github.com/stacksjs/dtsx#readme
 * @buildDependencies `curl.se`, `info-zip.org/unzip`, `gnu.org/coreutils` - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.zigdtsxstacksjsorg
 * console.log(pkg.name)        // "dtsx-native"
 * console.log(pkg.description) // "High-performance .d.ts emitter for TypeScript, ..."
 * console.log(pkg.programs)    // ["zig-dtsx"]
 * console.log(pkg.versions[0]) // "0.11.52" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/zig-dtsx-stacksjs-org.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const zigdtsxPackage = {
  /**
  * The display name of this package.
  */
  name: 'dtsx-native' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'zig-dtsx.stacksjs.org' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'High-performance .d.ts emitter for TypeScript, written in Zig. The standalone CLI is distributed separately from the zig-dtsx JavaScript FFI package.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://github.com/stacksjs/dtsx#readme' as const,
  githubUrl: 'https://github.com/stacksjs/dtsx' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install zig-dtsx.stacksjs.org' as const,
  pantryInstallCommand: 'pantry install zig-dtsx.stacksjs.org' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'zig-dtsx',
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
    '0.11.52',
  ] as const,
  aliases: [] as const,
}

export type ZigdtsxPackage = typeof zigdtsxPackage
