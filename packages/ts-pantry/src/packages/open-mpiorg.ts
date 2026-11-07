/**
 * **open-mpi** - Open MPI main development repository
 *
 * @domain `open-mpi.org`
 * @programs `mpic++`, `mpiCC`, `mpicc`, `mpicxx`, `mpiexec`, ... (+6 more)
 * @version `6.0.0rc3` (29 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install open-mpi.org`
 * @homepage https://www.open-mpi.org
 * @dependencies `open-mpi.org/hwloc`, `openpmix.github.io@5`, `libevent.org`
 * @buildDependencies `zlib.net@^1`, `python.org@^3`, `gnu.org/binutils`, ... (+1 more) - required only when building from source
 * @companions `OMPI_F77FLAGS^$FCFLAGS -I{{prefix}}/include`, `OMPI_F90FLAGS^$FCFLAGS -I{{prefix}}/include`
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.openmpiorg
 * console.log(pkg.name)        // "open-mpi"
 * console.log(pkg.description) // "Open MPI main development repository"
 * console.log(pkg.programs)    // ["mpic++", "mpiCC", ...]
 * console.log(pkg.versions[0]) // "6.0.0rc3" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/open-mpi-org.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const openmpiorgPackage = {
  /**
  * The display name of this package.
  */
  name: 'open-mpi' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'open-mpi.org' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'Open MPI main development repository' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/open-mpi.org/package.yml' as const,
  homepageUrl: 'https://www.open-mpi.org' as const,
  githubUrl: 'https://github.com/open-mpi/ompi' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install open-mpi.org' as const,
  pantryInstallCommand: 'pantry install open-mpi.org' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'mpic++',
    'mpiCC',
    'mpicc',
    'mpicxx',
    'mpiexec',
    'mpif77',
    'mpif90',
    'mpifort',
    'mpirun',
    'ompi_info',
    'opal_wrapper',
  ] as const,
  /**
  * Related packages that work well with this package.
  * Consider installing these for enhanced functionality.
  */
  companions: [
    'OMPI_F77FLAGS^$FCFLAGS -I{{prefix}}/include',
    'OMPI_F90FLAGS^$FCFLAGS -I{{prefix}}/include',
  ] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  */
  dependencies: [
    'open-mpi.org/hwloc',
    'openpmix.github.io@5',
    'libevent.org',
  ] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'zlib.net@^1',
    'python.org@^3',
    'gnu.org/binutils',
    'gnu.org/gcc',
  ] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '6.0.0rc3',
    '6.0.0rc2',
    '6.0.0rc1',
    '5.0.11',
    '5.0.11rc1',
    '5.0.10',
    '5.0.10rc2',
    '5.0.10rc1',
    '5.0.9',
    '5.0.9rc2',
    '5.0.9rc1',
    '5.0.9amzn1',
    '5.0.8',
    '5.0.8rc3',
    '5.0.8rc2',
    '5.0.8rc1',
    '5.0.8amzn1',
    '5.0.7',
    '5.0.7rc2',
    '5.0.7rc1',
    '5.0.6',
    '5.0.5',
    '5.0.4',
    '5.0.3',
    '5.0.2',
    '5.0.1',
    '4.1.8',
    '4.1.7',
    '4.1.5',
  ] as const,
  aliases: [] as const,
}

export type OpenmpiorgPackage = typeof openmpiorgPackage
