/**
 * **kerberos** - mirror of MIT krb5 repository
 *
 * @domain `kerberos.org`
 * @programs `compile_et`, `gss-client`, `k5srvutil`, `kadmin`, `kdestroy`, ... (+22 more)
 * @version `1.22.2` (74 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install kerberos.org`
 * @dependencies `openssl.org^1.1`
 * @buildDependencies `gnu.org/bison@3` - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.kerberosorg
 * console.log(pkg.name)        // "kerberos"
 * console.log(pkg.description) // "mirror of MIT krb5 repository"
 * console.log(pkg.programs)    // ["compile_et", "gss-client", ...]
 * console.log(pkg.versions[0]) // "1.22.2" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/kerberos-org.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const kerberosorgPackage = {
  /**
  * The display name of this package.
  */
  name: 'kerberos' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'kerberos.org' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'mirror of MIT krb5 repository' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/kerberos.org/package.yml' as const,
  homepageUrl: '' as const,
  githubUrl: 'https://github.com/krb5/krb5' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install kerberos.org' as const,
  pantryInstallCommand: 'pantry install kerberos.org' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'compile_et',
    'gss-client',
    'k5srvutil',
    'kadmin',
    'kdestroy',
    'kinit',
    'klist',
    'kpasswd',
    'krb5-config',
    'kswitch',
    'ktutil',
    'kvno',
    'sclient',
    'sim_client',
    'uuclient',
    'gss-server',
    'kadmin.local',
    'kadmind',
    'kdb5_util',
    'kprop',
    'kpropd',
    'kproplog',
    'krb5-send-pr',
    'krb5kdc',
    'sim_server',
    'sserver',
    'uuserver',
  ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  */
  dependencies: [
    'openssl.org^1.1',
  ] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'gnu.org/bison@3',
  ] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '1.22.2',
    '1.22.1',
    '1.22',
    '1.22.0',
    '1.21.3',
    '1.21.2',
    '1.21.1',
    '1.21',
    '1.21.0',
    '1.20.2',
    '1.20.1',
    '1.20',
    '1.19.4',
    '1.19.3',
    '1.19.2',
    '1.19.1',
    '1.19',
    '1.18.5',
    '1.18.4',
    '1.18.3',
    '1.18.2',
    '1.18.1',
    '1.18',
    '1.17.2',
    '1.17.1',
    '1.17',
    '1.16.4',
    '1.16.3',
    '1.16.2',
    '1.16.1',
    '1.16',
    '1.15.5',
    '1.15.4',
    '1.15.3',
    '1.15.2',
    '1.15.1',
    '1.15',
    '1.14.6',
    '1.14.5',
    '1.14.4',
    '1.14.3',
    '1.14.2',
    '1.14.1',
    '1.14',
    '1.13.7',
    '1.13.6',
    '1.13.5',
    '1.13.4',
    '1.13.3',
    '1.13.2',
    '1.13.1',
    '1.13',
    '1.12.5',
    '1.12.4',
    '1.12.3',
    '1.12.2',
    '1.12.1',
    '1.12',
    '1.11.6',
    '1.11.5',
    '1.11.4',
    '1.11.3',
    '1.11.2',
    '1.11.1',
    '1.11',
    '1.10.7',
    '1.10.6',
    '1.10.5',
    '1.10.4',
    '1.10.3',
    '1.10.2',
    '1.10.1',
    '1.10',
    '1.9.5',
  ] as const,
  aliases: [] as const,
}

export type KerberosorgPackage = typeof kerberosorgPackage
