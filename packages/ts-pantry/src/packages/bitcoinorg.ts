/**
 * **bitcoin** - Decentralized, peer to peer payment network
 *
 * @domain `bitcoin.org`
 * @programs `bitcoin-cli`, `bitcoin-tx`, `bitcoin-util`, `bitcoin-wallet`, `bitcoind`
 * @version `31.1` (73 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install bitcoin.org`
 * @homepage https://bitcoincore.org/
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.bitcoinorg
 * console.log(pkg.name)        // "bitcoin"
 * console.log(pkg.description) // "Decentralized, peer to peer payment network"
 * console.log(pkg.programs)    // ["bitcoin-cli", "bitcoin-tx", ...]
 * console.log(pkg.versions[0]) // "31.1" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/bitcoin-org.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const bitcoinorgPackage = {
  /**
  * The display name of this package.
  */
  name: 'bitcoin' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'bitcoin.org' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'Decentralized, peer to peer payment network' as const,
  packageYmlUrl: 'https://github.com/pkgxdev/pantry/tree/main/projects/bitcoin.org/package.yml' as const,
  homepageUrl: 'https://bitcoincore.org/' as const,
  githubUrl: 'https://github.com/bitcoin/bitcoin' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install bitcoin.org' as const,
  pantryInstallCommand: 'pantry install bitcoin.org' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'bitcoin-cli',
    'bitcoin-tx',
    'bitcoin-util',
    'bitcoin-wallet',
    'bitcoind',
  ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  * OS-specific dependencies are prefixed with `os:` (e.g., `linux:freetype.org`).
  */
  dependencies: [] as const,
  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.
  * OS-specific dependencies are prefixed with `os:` (e.g., `linux:gnu.org/gcc`).
  */
  buildDependencies: [] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '31.1',
    '31.0',
    '30.3',
    '30.2',
    '30.2.0',
    '30.1',
    '30.1.0',
    '30.0',
    '30.0.0',
    '29.4',
    '29.3',
    '29.3.0',
    '29.2',
    '29.2.0',
    '29.1',
    '29.1.0',
    '29.0',
    '29.0.0',
    '28.4',
    '28.3',
    '28.3.0',
    '28.2',
    '28.2.0',
    '28.1',
    '28.1.0',
    '28.0',
    '28.0.0',
    '27.2',
    '27.2.0',
    '27.1',
    '27.1.0',
    '27.0',
    '27.0.0',
    '26.2',
    '26.2.0',
    '26.1',
    '26.1.0',
    '26.0',
    '26.0.0',
    '25.2',
    '25.2.0',
    '25.1',
    '25.1.0',
    '25.0',
    '25.0.0',
    '24.2',
    '24.2.0',
    '24.1',
    '24.1.0',
    '24.0.1',
    '23.2',
    '23.2.0',
    '23.1',
    '23.0',
    '22.1',
    '22.0',
    '0.21.1',
    '0.21.0',
    '0.20.1',
    '0.20.0',
    '0.19.1',
    '0.19.0.1',
    '0.18.1',
    '0.18.0',
    '0.17.1',
    '0.17.0.1',
    '0.17.0',
    '0.16.3',
    '0.16.2',
    '0.16.1',
    '0.16.0',
    '0.15.2',
    '0.14.3',
  ] as const,
  aliases: [] as const,
}

export type BitcoinorgPackage = typeof bitcoinorgPackage
