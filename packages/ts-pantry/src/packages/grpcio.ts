/**
 * **grpc** - The C based gRPC (C++, Python, Ruby, Objective-C, PHP, C#)
 *
 * @domain `grpc.io`
 * @programs `grpc_csharp_plugin`, `grpc_node_plugin`, `grpc_cpp_plugin`, `grpc_python_plugin`, `grpc_objective_c_plugin`, ... (+2 more)
 * @version `1.85.4` (53 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install grpc.io`
 * @homepage https://grpc.io/
 * @dependencies `c-ares.org`, `openssl.org^1.1`, `github.com/google/re2`, ... (+5 more) (includes platform-specific dependencies)
 * @buildDependencies `gnu.org/autoconf`, `gnu.org/automake`, `gnu.org/libtool`, ... (+3 more) (includes platform-specific dependencies) - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.grpcio
 * console.log(pkg.name)        // "grpc"
 * console.log(pkg.description) // "The C based gRPC (C++, Python, Ruby, Objective-..."
 * console.log(pkg.programs)    // ["grpc_csharp_plugin", "grpc_node_plugin", ...]
 * console.log(pkg.versions[0]) // "1.85.4" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/grpc-io.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const grpcioPackage = {
  /**
  * The display name of this package.
  */
  name: 'grpc' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'grpc.io' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'The C based gRPC (C++, Python, Ruby, Objective-C, PHP, C#)' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/grpc.io/package.yml' as const,
  homepageUrl: 'https://grpc.io/' as const,
  githubUrl: 'https://github.com/grpc/grpc' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install grpc.io' as const,
  pantryInstallCommand: 'pantry install grpc.io' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'grpc_csharp_plugin',
    'grpc_node_plugin',
    'grpc_cpp_plugin',
    'grpc_python_plugin',
    'grpc_objective_c_plugin',
    'grpc_ruby_plugin',
    'grpc_php_plugin',
  ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  * Platform-specific dependencies use `os:` or `os/arch:` prefixes (e.g., `linux:freetype.org`).
  */
  dependencies: [
    'c-ares.org',
    'openssl.org^1.1',
    'github.com/google/re2',
    'zlib.net',
    'darwin:abseil.io^20260526',
    'linux:abseil.io^20250512',
    'linux:gnu.org/gcc/libstdcxx@14',
    'linux:protobuf.dev>=30',
  ] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  * Platform-specific dependencies use `os:` or `os/arch:` prefixes (e.g., `linux:gnu.org/gcc`).
  */
  buildDependencies: [
    'gnu.org/autoconf',
    'gnu.org/automake',
    'gnu.org/libtool',
    'cmake.org^3',
    'git-scm.org^2',
    'darwin:gnu.org/patch',
  ] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '1.85.4',
    '1.85.3',
    '1.85.2',
    '1.85.1',
    '1.85.0',
    '1.84.4',
    '1.84.3',
    '1.84.2',
    '1.84.1',
    '1.84.0',
    '1.83.2',
    '1.83.1',
    '1.83.0',
    '1.82.3',
    '1.82.2',
    '1.82.1',
    '1.82.0',
    '1.81.2',
    '1.81.1',
    '1.81.0',
    '1.80.1',
    '1.80.0',
    '1.78.2',
    '1.78.1',
    '1.78.0',
    '1.76.0',
    '1.75.1',
    '1.75.0',
    '1.74.1',
    '1.74.0',
    '1.73.1',
    '1.73.0',
    '1.72.2',
    '1.72.1',
    '1.72.0',
    '1.71.2',
    '1.71.1',
    '1.71.0',
    '1.70.2',
    '1.70.1',
    '1.70.0',
    '1.69.0',
    '1.68.2',
    '1.68.1',
    '1.68.0',
    '1.67.1',
    '1.67.0',
    '1.66.2',
    '1.66.1',
    '1.66.0',
    '1.65.5',
    '1.65.4',
    '1.58.3',
  ] as const,
  aliases: [] as const,
  runtimeEnvironment: undefined,
  platformPrograms: {
    darwin: [
      'grpc_cli',
    ] as const,
  },
}

export type GrpcioPackage = typeof grpcioPackage
