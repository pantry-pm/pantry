const config = {
  verbose: false,
  outDir: './dist',

  nav: [
    { text: 'Home', link: '/' },
    { text: 'Guide', link: '/intro' },
    { text: 'Install', link: '/install' },
    { text: 'Package Catalog', link: '/package-catalog' },
    { text: 'API', link: '/api-reference' },
    { text: 'GitHub', link: 'https://github.com/pantry-pm/pantry/tree/main/packages/ts-pantry' },
  ],

  markdown: {
    title: 'ts-pantry — Pantry Package Information',
    meta: {
      description: 'Fetch & access package data from Pantry with ease — typed package metadata, batch fetching, and CLI tooling.',
      author: 'Stacks.js',
      keywords: 'pantry, pkgx, packages, typescript, package data, bun',
    },

    sidebar: {
      '/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/intro' },
            { text: 'Installation', link: '/install' },
            { text: 'Usage', link: '/usage' },
            { text: 'Configuration', link: '/config' },
            { text: 'Pantry Integration', link: '/pantry-integration' },
          ],
        },
        {
          text: 'Features',
          items: [
            { text: 'Overview', link: '/features' },
            { text: 'Package Discovery', link: '/features/discovery' },
            { text: 'Multiple Fetching', link: '/features/multiple-fetching' },
            { text: 'Batch Processing', link: '/features/batch-processing' },
            { text: 'Dependency Resolution', link: '/features/dependency-resolution' },
            { text: 'Domains', link: '/features/domains' },
            { text: 'Management', link: '/features/management' },
            { text: 'TypeScript', link: '/features/typescript' },
            { text: 'CLI', link: '/features/cli' },
          ],
        },
        {
          text: 'Advanced',
          items: [
            { text: 'Aliases', link: '/advanced/aliases' },
            { text: 'Batch Processing', link: '/advanced/batch-processing' },
            { text: 'Output Formats', link: '/advanced/output-formats' },
            { text: 'Transformations', link: '/advanced/transformations' },
            { text: 'Type Safety', link: '/advanced/type-safety' },
            { text: 'Error Handling', link: '/advanced/error-handling' },
            { text: 'Rate Limits', link: '/advanced/rate-limits' },
            { text: 'Maintenance', link: '/advanced/maintenance' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'CLI Reference', link: '/cli-reference' },
            { text: 'API Reference', link: '/api-reference' },
            { text: 'TypeScript Types', link: '/typescript-types' },
            { text: 'Package Catalog', link: '/package-catalog' },
          ],
        },
        {
          text: 'Resources',
          items: [
            { text: 'Showcase', link: '/showcase' },
            { text: 'Team', link: '/team' },
            { text: 'Sponsors', link: '/sponsors' },
            { text: 'License', link: '/license' },
          ],
        },
      ],
    },

    toc: {
      enabled: true,
      position: 'sidebar',
      title: 'On this page',
      minDepth: 2,
      maxDepth: 4,
      smoothScroll: true,
      activeHighlight: true,
    },

    syntaxHighlightTheme: 'github-dark',

    features: {
      containers: true,
      githubAlerts: true,
      codeBlocks: {
        lineNumbers: true,
        lineHighlighting: true,
        focus: true,
        diffs: true,
        errorWarningMarkers: true,
      },
      codeGroups: true,
      emoji: true,
      badges: true,
    },
  },

  sitemap: {
    enabled: true,
    baseUrl: 'https://pantry.sh',
  },

  robots: {
    enabled: true,
    rules: [
      {
        userAgent: '*',
        allow: ['/'],
        disallow: ['/draft/'],
      },
    ],
  },
} as const

export default config
