/**
 * **claude-code** - Claude Code, Anthropic's agentic coding CLI
 *
 * @domain `anthropic.com/claude-code`
 * @programs `claude`
 * @version `2.1.185` (1 version available)
 * @versions From newest version to oldest.
 *
 * @install `pantry install anthropic.com/claude-code`
 *
 * @example
 * ```typescript
 * import { pantry } from 'ts-pantry'
 *
 * const pkg = pantry.anthropiccomclaudecode
 * console.log(pkg.name)        // "claude-code"
 * console.log(pkg.programs)    // ["claude"]
 * console.log(pkg.versions[0]) // "2.1.185" (latest)
 * ```
 *
 * @see https://ts-pantry.netlify.app/packages/anthropic-com/claude-code.md
 * @see https://ts-pantry.netlify.app/usage
 */
export const anthropiccomclaudecodePackage = {
  /**
  * The display name of this package.
  */
  name: 'claude-code' as const,
  /**
  * The canonical domain name for this package.
  */
  domain: 'anthropic.com/claude-code' as const,
  /**
  * Brief description of what this package does.
  */
  description: 'Claude Code — Anthropic\'s agentic coding CLI that lives in your terminal.' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://github.com/anthropics/claude-code' as const,
  githubUrl: 'https://github.com/anthropics/claude-code' as const,
  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */
  installCommand: 'pantry install anthropic.com/claude-code' as const,
  pantryInstallCommand: 'pantry install anthropic.com/claude-code' as const,
  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */
  programs: [
    'claude',
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
    '2.1.211',
    '2.1.210',
    '2.1.209',
    '2.1.208',
    '2.1.207',
    '2.1.206',
    '2.1.205',
    '2.1.204',
    '2.1.203',
    '2.1.202',
    '2.1.201',
    '2.1.200',
    '2.1.199',
    '2.1.198',
    '2.1.197',
    '2.1.196',
    '2.1.195',
    '2.1.193',
    '2.1.191',
    '2.1.190',
    '2.1.187',
    '2.1.186',
    '2.1.185',
  ] as const,
  aliases: [] as const,
}

export type AnthropiccomclaudecodePackage = typeof anthropiccomclaudecodePackage
