import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface DocumentationContractSources {
  packageManagerDoc: string
  registryDoc: string
  packageGuide: string
  faqDoc: string
  registryReadme: string
  mainSource: string
  installPipelineSource: string
  registryServerSource: string
  zigRoutesSource: string
  phpRoutesSource: string
}

interface ContractMarker {
  label: string
  source: keyof DocumentationContractSources
  sourceMarker: string
  document: 'packageManagerDoc' | 'registryDoc'
  documentMarker: string
}

const markers: ContractMarker[] = [
  ...['install', 'ci', 'add', 'remove', 'uninstall', 'update', 'outdated', 'list', 'why', 'tree', 'dedupe', 'link', 'unlink', 'audit', 'search', 'info', 'publish', 'npm:publish', 'publish:check', 'publish:commit', 'publish:binary', 'sign', 'verify'].map(command => ({
    label: `package command ${command}`,
    source: 'mainSource' as const,
    sourceMarker: `BaseCommand.init(allocator, "${command}"`,
    document: 'packageManagerDoc' as const,
    documentMarker: `pantry ${command}`,
  })),
  ...['frozen-lockfile', 'offline', 'ignore-scripts', 'no-cache', 'dry-run', 'no-save', 'filter', 'production', 'dev', 'peer', 'force', 'global', 'user'].map(option => ({
    label: `install option --${option}`,
    source: 'mainSource' as const,
    sourceMarker: `Option.init("${option}"`,
    document: 'packageManagerDoc' as const,
    documentMarker: `--${option}`,
  })),
  {
    label: 'fail-closed unsupported integrity',
    source: 'installPipelineSource',
    sourceMarker: `indexOfScalar(u8, integrity, '-') orelse return false`,
    document: 'packageManagerDoc',
    documentMarker: 'unsupported algorithm fails closed',
  },
  ...[
    ['health', `path === '/health'`, '/health'],
    ['search', `path === '/search'`, '/search?q={query}'],
    ['core publish', `path === '/publish'`, '/publish'],
    ['commit publish', `path === '/publish/commit'`, '/publish/commit'],
    ['npm resolve', `path === '/npm/resolve'`, '/npm/resolve'],
    ['registry download', `path === '/registry/download'`, '/registry/download'],
  ].map(([label, sourceMarker, documentMarker]) => ({
    label: `registry route ${label}`,
    source: 'registryServerSource' as const,
    sourceMarker,
    document: 'registryDoc' as const,
    documentMarker,
  })),
  { label: 'Zig search', source: 'zigRoutesSource', sourceMarker: `zigPath === '/search'`, document: 'registryDoc', documentMarker: '/zig/search' },
  { label: 'Zig publish', source: 'zigRoutesSource', sourceMarker: `zigPath === '/publish'`, document: 'registryDoc', documentMarker: '/zig/publish' },
  { label: 'Zig hash', source: 'zigRoutesSource', sourceMarker: 'const hashMatch = zigPath.match', document: 'registryDoc', documentMarker: '/zig/hash/{hash}' },
  { label: 'PHP search', source: 'phpRoutesSource', sourceMarker: `phpPath === '/search'`, document: 'registryDoc', documentMarker: '/php/search' },
  { label: 'PHP publish', source: 'phpRoutesSource', sourceMarker: `phpPath === '/publish'`, document: 'registryDoc', documentMarker: '/php/publish' },
]

export function validateDocumentationContracts(sources: DocumentationContractSources): string[] {
  const errors: string[] = []
  for (const marker of markers) {
    if (!sources[marker.source].includes(marker.sourceMarker))
      errors.push(`${marker.label}: source marker is missing from ${marker.source}`)
    if (!sources[marker.document].includes(marker.documentMarker))
      errors.push(`${marker.label}: documentation marker is missing from ${marker.document}`)
  }

  if (sources.packageManagerDoc.length < 10_000)
    errors.push('package-manager contract is unexpectedly incomplete')
  if (sources.registryDoc.length < 10_000)
    errors.push('registry contract is unexpectedly incomplete')
  for (const [name, contents] of [
    ['package-management guide', sources.packageGuide],
    ['FAQ', sources.faqDoc],
    ['registry README', sources.registryReadme],
  ] as const) {
    if (/uses the pkgx registry through ts-pantry/i.test(contents))
      errors.push(`legacy pkgx-registry claim remains in the ${name}`)
  }

  for (const heading of ['Lockfile contract', 'Integrity, cache, and extraction', 'Lifecycle scripts and trust', 'Publication channels', 'Failure modes operators should preserve', 'Test and evidence map']) {
    if (!sources.packageManagerDoc.includes(`## ${heading}`))
      errors.push(`package-manager contract is missing section: ${heading}`)
  }
  for (const heading of ['Core package API', 'Commit package API', 'Zig API', 'PHP/Composer API', 'Authentication and authorization', 'Storage model', 'npm fallback and outbound request safety', 'HTTP and error contract', 'Test and evidence map']) {
    if (!sources.registryDoc.includes(`## ${heading}`))
      errors.push(`registry contract is missing section: ${heading}`)
  }
  return errors
}

export function loadDocumentationContractSources(root: string): DocumentationContractSources {
  const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
  return {
    packageManagerDoc: read('docs/package-manager.md'),
    registryDoc: read('docs/registry.md'),
    packageGuide: read('docs/features/package-management.md'),
    faqDoc: read('docs/faq.md'),
    registryReadme: read('packages/registry/README.md'),
    mainSource: read('packages/zig/src/main.zig'),
    installPipelineSource: read('packages/zig/src/install/pipeline.zig'),
    registryServerSource: read('packages/registry/src/server.ts'),
    zigRoutesSource: read('packages/registry/src/zig-routes.ts'),
    phpRoutesSource: read('packages/registry/src/php-routes.ts'),
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..')
  const errors = validateDocumentationContracts(loadDocumentationContractSources(root))
  if (errors.length) {
    console.error(errors.map(error => `- ${error}`).join('\n'))
    process.exit(1)
  }
  console.log(`Package-manager and registry documentation contracts are current (${markers.length} source-linked markers)`)
}
