/**
 * **pcap-config** - the LIBpcap interface to various kernel packet capture mechanism
 *
 * @domain `tcpdump.org`
 * @programs `pcap-config`
 * @version `1.10.7` (50 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install tcpdump.org`
 * @homepage https://www.tcpdump.org/
 * @buildDependencies `gnu.org/make`, `gnu.org/bison`, `github.com/westes/flex` - required only when building from source
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.tcpdumporg
 * console.log(pkg.name)        // "pcap-config"
 * console.log(pkg.description) // "the LIBpcap interface to various kernel packet ..."
 * console.log(pkg.programs)    // ["pcap-config"]
 * console.log(pkg.versions[0]) // "1.10.7" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/tcpdump-org.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const tcpdumporgPackage = {
  /**
  * The display name of this package.
  */
  name: 'pcap-config' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'tcpdump.org' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'the LIBpcap interface to various kernel packet capture mechanism' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/tcpdump.org/package.yml' as const,
  homepageUrl: 'https://www.tcpdump.org/' as const,
  githubUrl: 'https://github.com/the-tcpdump-group/libpcap' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install tcpdump.org' as const,
  pantryInstallCommand: 'pantry install tcpdump.org' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'pcap-config',
  ] as const,
  companions: [] as const,
  dependencies: [] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  */
  buildDependencies: [
    'gnu.org/make',
    'gnu.org/bison',
    'github.com/westes/flex',
  ] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '1.10.7',
    '1.10.6',
    '1.10.5',
    '1.10.4',
    '1.10.3',
    '1.10.2',
    '1.10.1',
    '1.10.0',
    '1.10-bp',
    '1.9.1',
    '1.9.0',
    '1.9.0rc2',
    '1.9.0-rc1',
    '1.9-bp',
    '1.8.1',
    '1.8.0',
    '1.8.0-bp',
    '1.7.4',
    '1.7.3',
    '1.7.2',
    '1.7.0',
    '1.7.0-bp',
    '1.6.2',
    '1.6.1',
    '1.6.0-bp',
    '1.5.3',
    '1.5.2',
    '1.5.1',
    '1.5.0',
    '1.4.0',
    '1.3.0',
    '1.3-bp',
    '1.2.1',
    '1.1.1',
    '1.1.0',
    '1.0.0',
    '0.9.8',
    '0.9.7',
    '0.9.6',
    '0.9.5',
    '0.9.4',
    '0.9.3',
    '0.9.2',
    '0.9.1',
    '0.8.3',
    '0.8.2',
    '0.8.1',
    '0.8-bp',
    '0.7.2',
    '0.7.1',
  ] as const,
  aliases: [] as const,
}

export type TcpdumporgPackage = typeof tcpdumporgPackage
