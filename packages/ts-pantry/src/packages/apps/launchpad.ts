/** Native Launchpad application, published by its own Pantry release action. */
export const launchpadPackage = {
  name: 'Launchpad' as const,
  domain: 'github.com/stacksjs/launchpad' as const,
  description: 'A native keyboard launcher built with Stacks' as const,
  packageYmlUrl: '' as const,
  homepageUrl: 'https://launchpad.stacksjs.com' as const,
  githubUrl: 'https://github.com/stacksjs/launchpad' as const,
  installCommand: 'pantry install launchpad' as const,
  programs: [] as const,
  companions: [] as const,
  dependencies: [] as const,
  buildDependencies: ['jqlang.org'] as const,
  versions: ['1.0.3', '1.0.2', '1.0.1'] as const,
  aliases: ['launchpad'] as const,
}
