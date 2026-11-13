import type { FetchProjectsOptions, GitHubContent, PackageFetchOptions, PkgxPackage, ProjectFolder } from './types'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { DEFAULT_CACHE_DIR, DEFAULT_CACHE_EXPIRATION_MINUTES } from './consts'
import { aliases } from './packages/aliases'
import { dependencyPlatform, recipeDepsToSpecs } from './dependency-spec'
import { convertDomainToVarName } from './utils'

// Legacy browser references - keeping for backwards compatibility but not used
type Browser = any
const _sharedBrowser: Browser | null = null
const browserPool: { browser: Browser, inUse: boolean, createdAt: number }[] = []
const MAX_BROWSER_POOL_SIZE = 10

/**
 * Helper function to get domain as TypeScript variable name
 */
function getDomainAsTypescriptName(domain: string): string {
  // First handle the case where there are slashes (nested paths)
  if (domain.includes('/')) {
    // Split into parent domain and subpath
    const [parentDomain, ...subPathParts] = domain.split('/')
    const subPath = subPathParts.join('/')

    // Clean parent domain part (remove dots)
    const cleanParent = parentDomain.replace(/\./g, '')

    // For GitHub projects, use just the last part (the repo name) for cleaner export names
    if (parentDomain.includes('github.com')) {
      // For GitHub repos like github.com/lrstanley/vault-unseal, use just "vault-unseal" -> "vaultunseal"
      const pathParts = subPath.split('/')
      const repoName = pathParts[pathParts.length - 1] // Get the last part
      return repoName.replace(/[.-]/g, '').toLowerCase()
    }

    // For variable names, we need to remove ALL special characters including slashes in the subpath
    const cleanSubPath = subPath.replace(/[/.-]/g, '')

    // Join without a separator to make a valid variable name
    return `${cleanParent}${cleanSubPath}`.toLowerCase()
  }

  // For regular domains (no slashes), just remove dots
  return domain.replace(/\./g, '').toLowerCase()
}

/**
 * Generates JSDoc comments for specific object properties
 */
function getPropertyJSDoc(key: string, value: any): string | null {
  switch (key) {
    case 'versions':
      if (Array.isArray(value) && value.length > 0) {
        return `  /**
  * Available versions from newest to oldest.
  * @see https://ts-pantry.netlify.app/usage for installation instructions
  */`
      }
      break

    case 'programs':
      if (Array.isArray(value) && value.length > 0) {
        return `  /**
  * Executable programs provided by this package.
  * These can be run after installation.
  */`
      }
      break

    case 'dependencies':
      if (Array.isArray(value) && value.length > 0) {
        // Check if any dependencies are OS-specific
        const hasOsDeps = value.some(dep => typeof dep === 'string' && dep.includes(':'))
        const osNote = hasOsDeps ? '\n  * Platform-specific dependencies use `os:` or `os/arch:` prefixes (e.g., `linux:freetype.org`).' : ''

        return `  /**
  * Runtime dependencies for this package.
  * These are required when running the package.${osNote}
  */`
      }
      break

    case 'buildDependencies':
      if (Array.isArray(value) && value.length > 0) {
        // Check if any dependencies are OS-specific
        const hasOsDeps = value.some(dep => typeof dep === 'string' && dep.includes(':'))
        const osNote = hasOsDeps ? '\n  * Platform-specific dependencies use `os:` or `os/arch:` prefixes (e.g., `linux:gnu.org/gcc`).' : ''

        return `  /**
  * Build dependencies for this package.
  * These are only required when building the package from source.${osNote}
  */`
      }
      break

    case 'companions':
      if (Array.isArray(value) && value.length > 0) {
        return `  /**
  * Related packages that work well with this package.
  * Consider installing these for enhanced functionality.
  */`
      }
      break

    case 'aliases':
      if (Array.isArray(value) && value.length > 0) {
        return `  /**
  * Alternative names for this package.
  * You can use any of these names to access the package.
  */`
      }
      break

    case 'installCommand':
      return `  /**
  * Command to install this package using pantry.
  * @example pantry install package-name
  */`

    case 'description':
      return `  /**
  * Brief description of what this package does.
  */`

    case 'domain':
      return `  /**
  * The canonical domain name for this package.
  */`

    case 'name':
      return `  /**
  * The display name of this package.
  */`

    default:
      return null
  }

  return null
}

/** Quote metadata without changing backslashes, newlines or quotation marks. */
function quoteTypeScriptString(value: string): string {
  return `'${JSON.stringify(value).slice(1, -1).replace(/'/g, '\\\'')}'`
}

/** Format an object with literal assertions while preserving its authored data. */
function formatObjectWithAsConst(obj: Record<string, any>): string {
  const lines: string[] = []

  lines.push('{')

  // Add each property with appropriate formatting and JSDoc comments
  for (const [key, value] of Object.entries(obj)) {
    // Skip fetchedAt property to keep it out of TypeScript files
    if (key === 'fetchedAt')
      continue

    // Add JSDoc comments for specific properties
    const jsdocComment = getPropertyJSDoc(key, value)
    if (jsdocComment) {
      lines.push(jsdocComment)
    }

    const property = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)

    if (value === undefined) {
      lines.push(`  ${property}: undefined,`)
      continue
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        // Empty array
        lines.push(`  ${property}: [] as const,`)
      }
      else if (typeof value[0] === 'string') {
        // Export authored metadata without interpreting aliases or string contents.
        lines.push(`  ${property}: [`)
        for (const item of value) {
          lines.push(`    ${quoteTypeScriptString(item)},`)
        }
        lines.push(`  ] as const,`)
      }
      else {
        lines.push(`  ${property}: ${JSON.stringify(value)} as const,`)
      }
    }
    else if (typeof value === 'string') {
      lines.push(`  ${property}: ${quoteTypeScriptString(value)} as const,`)
    }
    else if (typeof value === 'number' || typeof value === 'boolean') {
      // Numbers and booleans with 'as const'
      lines.push(`  ${property}: ${value} as const,`)
    }
    else if (value === null) {
      // Null values
      lines.push(`  ${property}: null,`)
    }
    else if (typeof value === 'object') {
      // Nested objects
      lines.push(`  ${property}: ${formatObjectWithAsConst(value).replace(/\n/g, '\n  ')},`)
    }
    else {
      lines.push(`  ${property}: ${JSON.stringify(value)},`)
    }
  }

  lines.push('}')

  return lines.join('\n')
}

/**
 * Generates comprehensive JSDoc documentation for a package
 */
function documentedPackageAccess(key: string): string {
  return /^[a-z_$][\w$]*$/i.test(key) ? `pantry.${key}` : `pantry[${JSON.stringify(key)}]`
}

function generatePackageJSDoc(packageInfo: PkgxPackage, domainName: string, packageDisplayName: string): string {
  const lines: string[] = []

  lines.push('/**')

  // Package title and description
  if (packageInfo.description) {
    lines.push(` * **${packageDisplayName}** - ${packageInfo.description.trim()}`)
  }
  else {
    lines.push(` * **${packageDisplayName}** - pkgx package`)
  }

  lines.push(' *')

  // Domain information
  lines.push(` * @domain \`${packageInfo.domain || domainName}\``)

  // Programs provided
  if (packageInfo.programs && packageInfo.programs.length > 0) {
    const programsList = packageInfo.programs.slice(0, 5).join('`, `')
    const morePrograms = packageInfo.programs.length > 5 ? `, ... (+${packageInfo.programs.length - 5} more)` : ''
    lines.push(` * @programs \`${programsList}\`${morePrograms}`)
  }

  // Latest version information
  if (packageInfo.versions && packageInfo.versions.length > 0) {
    lines.push(` * @version \`${packageInfo.versions[0]}\` (${packageInfo.versions.length} versions available)`)
    lines.push(` * @versions From newest version to oldest.`)
  }

  // Installation command
  if (packageInfo.installCommand) {
    lines.push(` *`)
    lines.push(` * @install \`${packageInfo.installCommand}\``)
  }

  // Aliases - filter out invalid shell command patterns and separate package name from true aliases
  if (packageInfo.aliases && packageInfo.aliases.length > 0) {
    const validAliases = packageInfo.aliases.filter((alias) => {
      // Filter out shell command patterns
      return !alias.includes('--') && !alias.includes('$SHELL') && !alias.includes('+') && !alias.includes('(') && !alias.includes(')')
    })

    if (validAliases.length > 0) {
      // Separate the package name from true aliases
      const packageName = packageInfo.name
      const trueAliases = validAliases.filter(alias => alias !== packageName)
      const packageNameAlias = validAliases.find(alias => alias === packageName)

      // Add @name if the package name is in the aliases list
      if (packageNameAlias) {
        lines.push(` * @name \`${packageNameAlias}\``)
      }

      // Add @aliases only for true aliases (not the package name)
      if (trueAliases.length > 0) {
        lines.push(` * @aliases ${trueAliases.map(a => `\`${a}\``).join(', ')}`)
      }
    }
  }

  // Homepage URL
  if (packageInfo.homepageUrl) {
    lines.push(` * @homepage ${packageInfo.homepageUrl}`)
  }

  // Runtime Dependencies
  if (packageInfo.dependencies && packageInfo.dependencies.length > 0) {
    const depsList = packageInfo.dependencies.slice(0, 3).join('`, `')
    const moreDeps = packageInfo.dependencies.length > 3 ? `, ... (+${packageInfo.dependencies.length - 3} more)` : ''

    // Check if any dependencies are OS-specific
    const hasOsDeps = packageInfo.dependencies.some(dep => dep.includes(':'))
    const osNote = hasOsDeps ? ' (includes platform-specific dependencies)' : ''

    lines.push(` * @dependencies \`${depsList}\`${moreDeps}${osNote}`)
  }

  // Build Dependencies
  if (packageInfo.buildDependencies && packageInfo.buildDependencies.length > 0) {
    const depsList = packageInfo.buildDependencies.slice(0, 3).join('`, `')
    const moreDeps = packageInfo.buildDependencies.length > 3 ? `, ... (+${packageInfo.buildDependencies.length - 3} more)` : ''

    // Check if any dependencies are OS-specific
    const hasOsDeps = packageInfo.buildDependencies.some(dep => dep.includes(':'))
    const osNote = hasOsDeps ? ' (includes platform-specific dependencies)' : ''

    lines.push(` * @buildDependencies \`${depsList}\`${moreDeps}${osNote} - required only when building from source`)
  }

  // Companions
  if (packageInfo.companions && packageInfo.companions.length > 0) {
    const companionsList = packageInfo.companions.slice(0, 3).join('`, `')
    const moreCompanions = packageInfo.companions.length > 3 ? `, ... (+${packageInfo.companions.length - 3} more)` : ''
    lines.push(` * @companions \`${companionsList}\`${moreCompanions}`)
  }

  lines.push(' *')

  // Usage example
  lines.push(' * @example')
  lines.push(' * ```typescript')
  lines.push(' * import { pantry } from \'ts-pantry\'')
  lines.push(' *')
  const domainAccess = documentedPackageAccess(convertDomainToVarName(domainName))

  // Show both alias and domain access if valid aliases exist
  if (packageInfo.aliases && packageInfo.aliases.length > 0) {
    // Find the first valid alias for the example
    const validAlias = packageInfo.aliases.find((alias) => {
      return !alias.includes('--') && !alias.includes('$SHELL') && !alias.includes('+') && !alias.includes('(') && !alias.includes(')')
    })

    if (validAlias) {
      // The index exposes literal aliases. Removing punctuation invented keys
      // such as dynamodblocal instead of the real ['dynamodb-local'] property.
      const aliasAccess = documentedPackageAccess(validAlias)

      // Check if the alias is the same as the package name
      const isAliasPackageName = validAlias === packageInfo.name

      if (isAliasPackageName) {
        lines.push(` * // Access the package`)
        lines.push(` * const pkg = ${aliasAccess}`)
        lines.push(` * // Or access via domain`)
        lines.push(` * const samePkg = ${domainAccess}`)
        lines.push(` * console.log(pkg === samePkg) // true`)
      }
      else {
        lines.push(` * // Access via alias (recommended)`)
        lines.push(` * const pkg = ${aliasAccess}`)
        lines.push(` * // Or access via domain`)
        lines.push(` * const samePkg = ${domainAccess}`)
        lines.push(` * console.log(pkg === samePkg) // true`)
      }
    }
    else {
      // No valid aliases, use domain only
      lines.push(` * const pkg = ${domainAccess}`)
    }
  }
  else {
    // Use the same function as the index generation to ensure consistency
    lines.push(` * const pkg = ${domainAccess}`)
  }

  lines.push(` * console.log(pkg.name)        // "${packageInfo.name || packageDisplayName}"`)

  if (packageInfo.description) {
    const shortDesc = packageInfo.description.length > 50 ? `${packageInfo.description.substring(0, 47)}...` : packageInfo.description
    lines.push(` * console.log(pkg.description) // "${shortDesc}"`)
  }

  if (packageInfo.programs && packageInfo.programs.length > 0) {
    lines.push(` * console.log(pkg.programs)    // [${packageInfo.programs.slice(0, 2).map(p => `"${p}"`).join(', ')}${packageInfo.programs.length > 2 ? ', ...' : ''}]`)
  }

  if (packageInfo.versions && packageInfo.versions.length > 0) {
    lines.push(` * console.log(pkg.versions[0]) // "${packageInfo.versions[0]}" (latest)`)
  }

  lines.push(' * ```')
  lines.push(' *')

  // Links to documentation
  lines.push(` * @see https://ts-pantry.netlify.app/packages/${domainName.replace(/\./g, '-')}.md`)
  lines.push(` * @see https://ts-pantry.netlify.app/usage`)

  lines.push(' */')

  return lines.join('\n')
}

/**
 * Generates TypeScript content for a package
 */
function generateTypeScriptContent(packageInfo: PkgxPackage, domainName: string, existingExport?: string): string {
  // Helper function to check if a string is a valid alias for variable naming
  function isValidAliasForVarName(alias: string): boolean {
    if (!alias || alias.length < 2)
      return false

    // Filter out shell command patterns
    if (alias.includes('--') || alias.includes('$SHELL') || alias.includes('+') || alias.includes('(') || alias.includes(')')) {
      return false
    }

    // Filter out generic words that shouldn't be standalone aliases
    const genericWords = ['cli', 'app', 'tool', 'server', 'client', 'api', 'lib', 'core']
    if (genericWords.includes(alias.toLowerCase())) {
      return false
    }

    // Filter out version strings
    if (/^[\d.]+$/.test(alias) && /^\d/.test(alias)) {
      return false
    }

    return true
  }

  // Determine the best variable name - use a valid primary alias if available, otherwise use domain
  let varName: string
  let packageDisplayName: string

  // Special case for yarn packages to avoid naming conflicts
  if (domainName === 'classic.yarnpkg.com') {
    varName = 'classicYarnPackage'
    packageDisplayName = 'yarn'
  }
  else if (domainName === 'yarnpkg.com') {
    varName = 'yarnPackage'
    packageDisplayName = 'yarn'
  }
  else if (packageInfo.aliases && packageInfo.aliases.length > 0) {
    // Find the first valid alias for variable naming
    const validAlias = packageInfo.aliases.find(alias => isValidAliasForVarName(alias))

    if (validAlias) {
      // Make sure the const variable name starts with lowercase
      const aliasBase = validAlias.replace(/[^a-z0-9]/gi, '')
      varName = `${aliasBase.charAt(0).toLowerCase()}${aliasBase.slice(1)}Package`
      packageDisplayName = validAlias
    }
    else {
      // No valid aliases, fall back to domain-based naming
      varName = `${getDomainAsTypescriptName(domainName)}Package`
      packageDisplayName = packageInfo.name || domainName
    }
  }
  else {
    // Fall back to domain-based naming
    varName = `${getDomainAsTypescriptName(domainName)}Package`
    packageDisplayName = packageInfo.name || domainName
  }

  // Ensure the variable name doesn't contain any invalid JavaScript identifier characters
  const safeVarName = existingExport || varName.replace(/[^\w$]/g, '')

  // Generate comprehensive JSDoc documentation
  const jsdoc = generatePackageJSDoc(packageInfo, domainName, packageDisplayName)

  // Format the package object with 'as const' assertions
  const formattedObj = formatObjectWithAsConst(packageInfo)

  // Create the TypeScript content with proper JSDoc, imports and exports
  return `${jsdoc}
export const ${safeVarName} = ${formattedObj}

export type ${safeVarName.charAt(0).toUpperCase() + safeVarName.slice(1)} = typeof ${safeVarName}
`
}

/**
 * Saves package data as a TypeScript file
 */
function sanitizeFilename(packageName: string): string {
  const sanitized = packageName.replace(/\{\{[^}]*\}\}/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  if (!sanitized || sanitized.length === 0)
    return 'package'

  let cleanName = sanitized.replace(/[^\w.-]/g, '-')

  // Handle extremely long filenames to avoid ENAMETOOLONG errors
  // Most filesystems support filenames up to 255 characters, but we'll be conservative
  // and limit to 200 characters, leaving room for ".ts" extension
  if (cleanName.length > 200) {
    // Keep the first 150 characters and last 45 characters, separated by "..."
    cleanName = `${cleanName.substring(0, 150)}...${cleanName.substring(cleanName.length - 45)}`
  }

  return cleanName
}

function packageOutputPath(outputDir: string, domainName: string, extension: 'ts' | 'json'): string {
  // Ensure base output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  let filePath: string

  // For nested domains (containing "/"), create proper directory structure
  if (domainName.includes('/')) {
    // Split the domain into parts: github.com/user/repo -> [github.com, user, repo]
    const parts = domainName.split('/')
    // Reject path-traversal segments to prevent writing outside outputDir
    if (parts.some(p => !p || p === '..' || p === '.' || p.includes('\0') || p.includes('\\'))) {
      throw new Error(`Invalid domain name (contains path-traversal): ${domainName}`)
    }
    const baseDomain = parts[0] // github.com
    const subParts = parts.slice(1) // [user, repo]

    // Create directory structure: outputDir/github.com/user/
    const packageDir = path.join(outputDir, baseDomain, ...subParts.slice(0, -1))
    // Defensive: ensure resolved path stays within outputDir
    const resolvedOutputDir = path.resolve(outputDir)
    if (!path.resolve(packageDir).startsWith(`${resolvedOutputDir}${path.sep}`) && path.resolve(packageDir) !== resolvedOutputDir) {
      throw new Error(`Path traversal detected for ${domainName}`)
    }
    if (!fs.existsSync(packageDir)) {
      fs.mkdirSync(packageDir, { recursive: true })
    }

    // Use the last part as filename: repo.ts
    const filename = sanitizeFilename(subParts[subParts.length - 1])
    filePath = path.join(packageDir, `${filename}.${extension}`)
  }
  else {
    // For root domains, use consistent domain-based naming
    // Strip dots entirely from root domains (e.g., alacritty.org -> alacrittyorg)
    const filename = domainName.replace(/\./g, '')

    // Create the TypeScript file path in the base directory
    filePath = path.join(outputDir, `${filename}.${extension}`)
  }

  return filePath
}

function savePackageAsJson(outputDir: string, domainName: string, packageInfo: PkgxPackage): string {
  const filePath = packageOutputPath(outputDir, domainName, 'json')
  const cleanPackageInfo = { ...packageInfo }
  delete cleanPackageInfo.fetchedAt
  fs.writeFileSync(filePath, `${JSON.stringify(cleanPackageInfo, null, 2)}\n`)
  return filePath
}

export function savePackageAsTypeScript(outputDir: string, domainName: string, packageInfo: PkgxPackage): string {
  const filePath = packageOutputPath(outputDir, domainName, 'ts')
  // Remove fetchedAt from the package info before generating TypeScript
  const cleanPackageInfo = { ...packageInfo }
  delete cleanPackageInfo.fetchedAt

  // Generate TypeScript content
  const existingExport = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8').match(/^export const ([A-Za-z_$][\w$]*) =/m)?.[1]
    : undefined
  const tsContent = generateTypeScriptContent(cleanPackageInfo, domainName, existingExport)

  // Write the file
  fs.writeFileSync(filePath, tsContent)

  return filePath
}

/**
 * Removes generated .ts files from the output directory that were not part of the
 * current fetch run. Prevents stale generated files from accumulating.
 */
export function cleanStaleOutputFiles(outputDir: string, savedPackages: string[]): string[] {
  if (!fs.existsSync(outputDir)) return []

  // Build set of expected file paths from saved packages
  const expectedFiles = new Set<string>()
  for (const domain of savedPackages) {
    if (domain.includes('/')) {
      const parts = domain.split('/')
      const baseDomain = parts[0]
      const subParts = parts.slice(1)
      const filename = sanitizeFilename(subParts[subParts.length - 1])
      expectedFiles.add(path.resolve(outputDir, baseDomain, ...subParts.slice(0, -1), `${filename}.ts`))
    }
    else {
      const filename = domain.replace(/\./g, '')
      expectedFiles.add(path.resolve(outputDir, `${filename}.ts`))
    }
  }

  // Also preserve known non-generated files
  const preservedFiles = new Set(['index.ts', 'aliases.ts', 'types.ts'])

  const removed: string[] = []

  function walkDir(dir: string) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walkDir(fullPath)
        // Remove empty directories left behind
        if (fs.existsSync(fullPath) && fs.readdirSync(fullPath).length === 0) {
          fs.rmdirSync(fullPath)
        }
      }
      else if (entry.name.endsWith('.ts') && !preservedFiles.has(entry.name)) {
        if (!expectedFiles.has(path.resolve(fullPath))) {
          fs.unlinkSync(fullPath)
          removed.push(fullPath)
        }
      }
    }
  }

  walkDir(outputDir)
  return removed
}

/**
 * Checks if a cached package exists and is still valid
 * @param packageName Name of the package to check
 * @param options Cache options
 * @returns The cached package data if valid, null otherwise
 */
export function getValidCachedPackage(
  packageName: string,
  options: PackageFetchOptions = {},
): { packageInfo: PkgxPackage, filePath: string } | null {
  try {
    // Determine cache directory
    const cacheDir = options.cacheDir || DEFAULT_CACHE_DIR

    // If cache is disabled, return null immediately
    if (options.cache === false) {
      console.log(`Cache disabled for ${packageName}, skipping cache check`)
      return null
    }

    // Handle aliases - need to check the canonical name
    const resolvedName = aliases[packageName] || packageName

    // Create a safe filename for the cache file - always use domain-based naming for cache
    // to ensure consistency regardless of package name extraction
    const safeFilename = resolvedName.replace(/\//g, '-')
    const cacheFilePath = path.join(cacheDir, `${safeFilename}.json`)

    console.log(`Checking for cache file: ${cacheFilePath}`)

    // Check if the cache file exists
    if (!fs.existsSync(cacheFilePath)) {
      return null
    }

    // Read and parse the cached data
    let cachedData: PkgxPackage
    try {
      cachedData = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8')) as PkgxPackage
    }
    catch {
      // Corrupt cache file — remove it and return null
      try { fs.unlinkSync(cacheFilePath) } catch { /* ignore */ }
      return null
    }

    // Check if the cached data has a fetchedAt timestamp
    if (!cachedData.fetchedAt) {
      console.log(`Cache for ${packageName} missing fetchedAt timestamp, invalidating`)
      return null
    }

    // Check for generic/placeholder descriptions that indicate bad cached data
    const genericDescriptions = [
      'Crafters of fine Open Source products',
      'Go home.',
      'Package information for',
      'pkgx package',
      'Loading...',
      'Please wait...',
    ]

    const hasGenericDescription = genericDescriptions.some(generic =>
      cachedData.description && cachedData.description.includes(generic),
    )

    if (hasGenericDescription) {
      console.log(`Cache for ${packageName} has generic description "${cachedData.description}", invalidating`)
      return null
    }

    // Check if the package has no versions (likely incomplete data)
    if (!cachedData.versions || cachedData.versions.length === 0) {
      console.log(`Cache for ${packageName} has no versions, invalidating`)
      return null
    }

    // Check if the cache has expired
    const cacheExpirationMinutes = options.cacheExpirationMinutes || DEFAULT_CACHE_EXPIRATION_MINUTES
    const cacheExpirationMs = cacheExpirationMinutes * 60 * 1000
    const now = Date.now()

    if (now - cachedData.fetchedAt > cacheExpirationMs) {
      console.log(`Cache for ${packageName} has expired (age: ${Math.round((now - cachedData.fetchedAt) / 60000)} minutes)`)
      return null
    }

    console.log(`Using cached data for ${packageName} (age: ${Math.round((now - cachedData.fetchedAt) / 60000)} minutes)`)
    return { packageInfo: cachedData, filePath: cacheFilePath }
  }
  catch (error) {
    console.error(`Error reading cache for ${packageName}:`, error)
    return null
  }
}

/**
 * Saves package data to the cache
 * @param packageName Name of the package
 * @param packageInfo Package data to cache
 * @param options Cache options
 * @returns Path to the cached file
 */
export function saveToCacheAndOutput(
  packageName: string,
  packageInfo: PkgxPackage,
  options: PackageFetchOptions = {},
): { cachePath: string, outputPath: string } {
  const cacheDir = options.cacheDir || DEFAULT_CACHE_DIR
  const cachePath = path.join(cacheDir, `${packageName.replace(/\//g, '-')}.json`)
  if (options.cache !== false) {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify({ ...packageInfo, fetchedAt: Date.now() }, null, 2))
  }
  const outputDir = options.outputDir || 'packages'
  const outputPath = options.json
    ? savePackageAsJson(outputDir, packageName, packageInfo)
    : savePackageAsTypeScript(outputDir, packageName, packageInfo)
  return { cachePath, outputPath }
}

// Function to check system resources and adjust behavior
function _getSystemResourceStatus() {
  const memUsage = process.memoryUsage()
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024)
  const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024)
  const rssUsedMB = Math.round(memUsage.rss / 1024 / 1024)

  // Consider system under stress if heap usage is high, RSS is very high, or we have many browsers
  const isUnderStress = heapUsedMB > 300 || rssUsedMB > 800 || browserPool.length >= MAX_BROWSER_POOL_SIZE

  return {
    heapUsedMB,
    heapTotalMB,
    rssUsedMB,
    browserCount: browserPool.length,
    isUnderStress,
  }
}

// Navigation logging disabled - kept for backwards compatibility

/**
 * Ensures all browser resources are properly closed
 */
export function cleanupBrowserResources(): Promise<void> {
  // Return a promise that always resolves and never rejects
  return Promise.resolve()
}

/**
 * Fetches project folder names from the pkgxdev pantry repository using GitHub API
 * @param options Optional configuration
 * @returns Promise resolving to an array of project folders
 */
export async function fetchPkgxProjects(options: FetchProjectsOptions = {}): Promise<ProjectFolder[]> {
  const apiUrl = options.apiUrl || 'https://api.github.com/repos/pkgxdev/pantry/contents/projects'

  try {
    console.log(`Fetching projects from GitHub API: ${apiUrl}`)

    const response = await fetch(apiUrl, {
      headers: {
        // Using GitHub API without authentication has a lower rate limit
        // If you hit rate limits, you'll need to add an auth token
        Accept: 'application/vnd.github.v3+json',
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch from GitHub API: ${response.statusText}`)
    }

    const contents = await response.json() as GitHubContent[]

    // Filter to only include directories
    const projects = contents
      .filter(item => item.type === 'dir')
      .map(item => ({
        name: item.name,
        url: item.html_url,
      }))

    console.log(`Retrieved ${projects.length} projects from GitHub API`)

    // Sort projects alphabetically for consistency
    projects.sort((a, b) => a.name.localeCompare(b.name))

    return projects
  }
  catch (error) {
    console.error('Error fetching projects from GitHub API:', error)
    throw error
  }
}

/**
 * Preserve mutable return values while checking the readonly catalog's schema.
 */
type ReadonlyMetadata<T> = T extends readonly unknown[]
  ? readonly ReadonlyMetadata<T[number]>[]
  : T extends object ? { readonly [K in keyof T]: ReadonlyMetadata<T[K]> } : T

/** Query the maintained catalog; upstream version discovery belongs to the version updater. */
export async function fetchPantryPackage(
  packageName: string,
  _options: PackageFetchOptions = {},
): Promise<{ packageInfo: PkgxPackage, originalName: string, fullDomainName: string }> {
  const { pantry } = await import('./packages')
  const canonical = aliases[packageName] ?? packageName
  const source: ReadonlyMetadata<PkgxPackage> | undefined = Object.values(pantry).find(pkg => pkg.domain === canonical)
  if (!source) throw new Error(`No maintained package metadata for ${packageName}`)
  // The catalog is shared readonly data; return an actual independent mutable copy.
  const packageInfo = structuredClone(source) as PkgxPackage
  return { packageInfo, originalName: packageName, fullDomainName: source.domain }
}

// Add periodic cleanup function for browser resources
const CLEANUP_INTERVAL = 300000 // 5 minutes
let cleanupInterval: NodeJS.Timeout | null = null

/**
 * Sets up process exit handlers to ensure proper cleanup
 */
export function setupCleanupHandlers(): void {
  // Add graceful shutdown handlers
  const exitHandler = async (signal: string) => {
    console.log(`\nReceived ${signal} signal. Cleaning up resources...`)

    // Clear any intervals
    if (cleanupInterval) {
      clearInterval(cleanupInterval)
    }

    // Perform cleanup of browser resources
    await cleanupBrowserResources()

    console.log('Resources cleaned up. Exiting.')

    // Force exit after 5 seconds if process is hanging
    setTimeout(() => {
      console.log('Forcing process exit...')
      process.exit(0)
    }, 5000)
  }

  // Handle various termination signals
  process.on('SIGINT', () => exitHandler('SIGINT'))
  process.on('SIGTERM', () => exitHandler('SIGTERM'))
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error)
    exitHandler('uncaughtException')
  })
}

/** Explicit opt-in for a command that owns the process and browser lifecycle. */
export function setupFetchProcessHandlers(): void {
  // Initialize handlers
  setupCleanupHandlers()

  // Add global error handlers to prevent crashes
  process.on('uncaughtException', (error) => {
    const errorString = String(error)
    console.error('Uncaught exception caught:', error.message)
    if (error.message.includes('No target found for targetId')
      || error.message.includes('Assertion error')
      || error.message.includes('Target page, context or browser has been closed')
      || error.message.includes('Failed to connect')
      || error.message.includes('Connection closed')
      || error.message.includes('Protocol error')
      || errorString.includes('WebSocket connection closed')
      || error.message.includes('Browser has been closed')) {
      console.error('Browser/network connection error detected, continuing execution...')
      // Don't exit the process for browser/network errors
      return
    }
    // For other uncaught exceptions, still exit
    console.error('Non-browser error, exiting...')
    process.exit(1)
  })

  process.on('unhandledRejection', (reason, _promise) => {
    const errorString = String(reason)
    console.error('Unhandled rejection caught:', errorString)
    if (errorString.includes('No target found for targetId')
      || errorString.includes('Assertion error')
      || errorString.includes('Target page, context or browser has been closed')
      || errorString.includes('Failed to connect')
      || errorString.includes('Connection closed')
      || errorString.includes('Protocol error')
      || errorString.includes('WebSocket connection closed')
      || errorString.includes('Browser has been closed')) {
      console.error('Browser/network connection error in promise, continuing execution...')
      // Don't exit the process for browser/network errors
      return
    }
    // For other unhandled rejections, still exit
    console.error('Non-browser promise rejection, exiting...')
    process.exit(1)
  })
}

// Start a periodic cleanup task
export function startPeriodicCleanup(): void {
  // Clear any existing interval
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
  }

  // Set a new interval to periodically clean up resources
  cleanupInterval = setInterval(() => {
    console.log('Running periodic browser resource cleanup...')
    cleanupBrowserResources()
      .then(() => console.log('Periodic cleanup completed'))
      .catch(err => console.error('Error during periodic cleanup:', err))
  }, CLEANUP_INTERVAL)
}

/**
 * Exports complete maintained catalog metadata, optionally limited to a subset
 */
export async function fetchAndSaveAllPackages(options: PackageFetchOptions = {}): Promise<string[]> {
  const { pantry } = await import('./packages')
  const domains = [...new Set(Object.values(pantry).map(pkg => pkg.domain))].sort()
  const requested = options.limit && options.limit > 0 ? domains.slice(0, options.limit) : domains
  const results = await Promise.all(requested.map(domain => fetchPantryPackage(domain, options)))
  for (const result of results) saveToCacheAndOutput(result.fullDomainName, result.packageInfo, options)
  return results.map(result => result.fullDomainName)
}

/**
 * Export a single package from the maintained catalog.
 * @param packageName The name of the package to fetch
 * @param outputDir Directory to save package data
 * @param timeout Timeout in milliseconds
 * @param saveAsJson Whether to save as JSON (true) or TypeScript (false)
 * @param retryNumber Current retry attempt number
 * @param maxRetries Maximum number of retry attempts
 * @param debug Whether to enable debug mode
 * @param options Additional options
 * @returns Promise with result information
 */
export async function fetchAndSavePackage(
  packageName: string,
  outputDir: string,
  _timeout: number,
  saveAsJson = false,
  _retryNumber = 1,
  _maxRetries = 3,
  _debug = false,
  options: PackageFetchOptions = {},
): Promise<{ success: boolean, fullDomainName?: string, aliases?: string[], filePath?: string }> {
  try {
    const result = await fetchPantryPackage(packageName, options)
    const { outputPath } = saveToCacheAndOutput(result.fullDomainName, result.packageInfo, { ...options, outputDir, json: saveAsJson })
    return { success: true, fullDomainName: result.fullDomainName, aliases: result.packageInfo.aliases, filePath: outputPath }
  }
  catch (error) {
    console.error(`Could not export package metadata for ${packageName}:`, error)
    return { success: false, fullDomainName: packageName }
  }
}

/**
 * Scans the local pantry directory and extracts all available packages
 * @param pantryDir Path to the pantry directory (default: 'src/pantry')
 * @returns Array of package names found in the pantry
 */
export async function scanPantryPackages(pantryDir = 'src/pantry'): Promise<string[]> {
  if (!fs.existsSync(pantryDir)) {
    throw new Error(`Pantry directory not found: ${pantryDir}. Please run 'bun ./bin/cli.ts update-pantry' first.`)
  }

  const packages: string[] = []

  function scanDirectory(dir: string, basePath = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    // First, check if the current directory has a package.yml file
    const packageYmlPath = path.join(dir, 'package.yml')
    if (basePath && fs.existsSync(packageYmlPath)) {
      packages.push(basePath)
    }

    // Then recursively scan subdirectories (always continue regardless of package.yml presence)
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const currentPath = basePath ? `${basePath}/${entry.name}` : entry.name
        const subDir = path.join(dir, entry.name)
        scanDirectory(subDir, currentPath)
      }
    }
  }

  scanDirectory(pantryDir)

  console.log(`Found ${packages.length} packages in pantry`)
  return packages.sort()
}

/**
 * The value of a YAML scalar as written after `key:` on one line: the content
 * of a quoted scalar, or a plain scalar with its inline comment removed.
 *
 * package.yml writes notes beside versions (`tcl-lang.org: =8.6.16 # 9.0.2
 * introduced a build issue on darwin`). The line regexes below used to keep
 * everything up to the next quote, so the note became part of the version and
 * flowed into every package file and generated.zig. A `#` only starts a
 * comment after whitespace, and never inside quotes.
 */
export function parseYamlScalar(raw: string): string {
  const value = raw.trim()
  const q = value[0]
  if (q === '"' || q === '\'') {
    for (let i = 1; i < value.length; i++) {
      const c = value[i]
      if (q === '"' && c === '\\') {
        i++
        continue
      }
      if (c !== q)
        continue
      if (q === '\'' && value[i + 1] === '\'') {
        i++
        continue
      }
      const inner = value.slice(1, i)
      return q === '\'' ? inner.replace(/''/g, '\'') : inner.replace(/\\(.)/g, '$1')
    }
  }
  const comment = value.search(/(^|\s)#/)
  return (comment >= 0 ? value.slice(0, comment) : value).trim()
}

/** Extract the dependency mapping schema without coercing version text into numbers. */
function dependencyDeclarations(content: string): {
  dependencies: Record<string, unknown>
  buildDependencies: Record<string, unknown>
  companions: Record<string, unknown>
} {
  const maps = {
    dependencies: Object.create(null) as Record<string, unknown>,
    buildDependencies: Object.create(null) as Record<string, unknown>,
    companions: Object.create(null) as Record<string, unknown>,
  }
  let section = ''
  let active: Record<string, unknown> | undefined
  let base = 2
  let group: Record<string, unknown> | undefined
  for (const line of content.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const mapping = /^(\s*)([^:#]+):\s*(.*)$/.exec(line)
    if (!mapping) continue
    const indent = mapping[1].length
    const name = parseYamlScalar(mapping[2].trim())
    const value = parseYamlScalar(mapping[3])
    if (indent === 0) {
      section = name
      active = name === 'dependencies' ? maps.dependencies : name === 'runtime' ? maps.companions : undefined
      group = undefined
      base = 2
      continue
    }
    if (section === 'build' && indent === 2) {
      active = name === 'dependencies' ? maps.buildDependencies : undefined
      group = undefined
      base = 4
      continue
    }
    if (!active) continue
    if (indent === base) {
      group = undefined
      if (section === 'runtime' && (name === 'env' || /^[A-Z_]+$/.test(name))) continue
      if (dependencyPlatform(name)) {
        if (value) throw new TypeError(`Dependency platform ${name} must contain a dependency map`)
        group = Object.create(null) as Record<string, unknown>
        active[name] = group
      }
      else active[name] = value || '*'
    }
    else if (group && indent === base + 2) group[name] = value || '*'
  }
  return maps
}

/**
 * Reads package.yml file and extracts basic package information
 * @param packageName The package name (e.g., 'github.com/user/repo')
 * @param pantryDir Path to the pantry directory
 * @returns Basic package information from package.yml
 */
export async function readPantryPackageInfo(packageName: string, pantryDir = 'src/pantry'): Promise<Partial<PkgxPackage> | null> {
  const packageYmlPath = path.join(pantryDir, packageName, 'package.yml')

  if (!fs.existsSync(packageYmlPath)) {
    console.warn(`Package.yml not found for ${packageName}`)
    return null
  }

  try {
    const yamlContent = fs.readFileSync(packageYmlPath, 'utf-8')

    const declarations = dependencyDeclarations(yamlContent)
    const runtimeDependencies = recipeDepsToSpecs(declarations.dependencies)
    const buildDependencies = recipeDepsToSpecs(declarations.buildDependencies)
    const companions = recipeDepsToSpecs(declarations.companions)
    const depsLines = yamlContent.split('\n')

    // Extract homepage and GitHub URLs from distributable.url
    let homepageUrl = ''
    let githubUrl = ''

    const distributableMatch = yamlContent.match(/distributable:[\t\v\f\r \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\n\s*url:\s*(.+)/)
    if (distributableMatch) {
      const url = distributableMatch[1].trim()
      if (url.includes('github.com')) {
        // Extract GitHub URL from git+https://github.com/owner/repo.git format
        const githubMatch = url.match(/git\+https:\/\/github\.com\/([^/]+\/[^.]+)/)
        if (githubMatch) {
          githubUrl = `https://github.com/${githubMatch[1]}`

          // For well-known projects, try to determine homepage URL
          const repoPath = githubMatch[1]
          if (repoPath === 'python-attrs/attrs') {
            homepageUrl = 'https://www.attrs.org/'
          }
          // Add more mappings as needed
        }
      }
    }

    // Extract programs from provides section
    const programs: string[] = []
    let inProvidesSection = false
    let inProvidesPlatformSection = false

    for (const line of depsLines) {
      if (line.match(/^provides:\s*$/)) {
        inProvidesSection = true
        inProvidesPlatformSection = false
        continue
      }

      if (inProvidesSection) {
        // Exit if we hit a non-indented, non-empty line
        if (line.match(/^\S/) && !line.match(/^\s*$/)) {
          inProvidesSection = false
          continue
        }

        // Skip platform headers like "darwin:" or "linux:"
        if (line.match(/^\s+(darwin|linux|windows):\s*$/)) {
          inProvidesPlatformSection = true
          continue
        }

        // Match "- bin/program" or "  - bin/program"
        const provideMatch = line.match(/^\s+-\s+(?:bin|sbin)\/(.+)/)
        if (provideMatch) {
          const prog = provideMatch[1].trim()
          if (!programs.includes(prog)) {
            programs.push(prog)
          }
        }
      }
    }

    const packageInfo: Partial<PkgxPackage> = {
      name: packageName.split('/').pop() || packageName,
      domain: packageName,
      dependencies: runtimeDependencies,
      buildDependencies,
      companions,
      programs,
      homepageUrl,
      githubUrl,
      // This is partial raw-recipe inspection, not complete export metadata.
    }

    return packageInfo
  }
  catch (error) {
    console.warn(`Error reading package.yml for ${packageName}:`, error)
    return null
  }
}

/**
 * Compatibility entry point for complete maintained catalog metadata
 * @param packageName The package name (e.g., 'github.com/user/repo')
 * @param options Export options; upstream discovery is owned by the version updater
 * @returns Complete package information
 */
export async function fetchPantryPackageWithMetadata(
  packageName: string,
  options: PackageFetchOptions = {},
): Promise<{ packageInfo: PkgxPackage, originalName: string, fullDomainName: string } | null> {
  return fetchPantryPackage(packageName, options)
}
