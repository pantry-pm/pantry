/**
 * **CLIProxyAPI** - CLI Proxy API — OpenAI/Gemini/Claude/Codex-compatible API for CLI subscriptions
 *
 * @domain `github.com/router-for-me/CLIProxyAPI`
 * @programs `cli-proxy-api`
 * @version `7.2.81` (12 versions available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install github.com/router-for-me/CLIProxyAPI`
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.cliproxyapi
 * console.log(pkg.name)        // "CLIProxyAPI"
 * console.log(pkg.programs)    // ["cli-proxy-api"]
 * console.log(pkg.versions[0]) // "7.2.81" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/github-com/router-for-me/CLIProxyAPI.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const cliproxyapiPackage = {
  /**
  * The display name of this package.
  */
  name: 'CLIProxyAPI' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'github.com/router-for-me/CLIProxyAPI' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'CLI Proxy API — use your Gemini CLI, Claude Code, Codex, Kimi, Qwen, iFlow and Grok CLI subscriptions through OpenAI/Gemini/Claude/Codex-compatible API endpoints.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://help.router-for.me/' as const,
  githubUrl: 'https://github.com/router-for-me/CLIProxyAPI' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install github.com/router-for-me/CLIProxyAPI' as const,
  pantryInstallCommand: 'pantry install github.com/router-for-me/CLIProxyAPI' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'cli-proxy-api',
  ] as const,
  companions: [] as const,
  /**
  * Runtime dependencies for this package.
  * These are required when running the package.
  */
  dependencies: [] as const,
  buildDependencies: [] as const,
  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */
  versions: [
    '7.2.81',
    '7.2.80',
    '7.2.79',
    '7.2.78',
    '7.2.77',
    '7.2.76',
    '7.2.75',
    '7.2.74',
    '7.2.73',
    '7.2.72',
    '7.2.71',
    '7.2.70',
  ] as const,
  aliases: [] as const,
}

export type CliproxyapiPackage = typeof cliproxyapiPackage
