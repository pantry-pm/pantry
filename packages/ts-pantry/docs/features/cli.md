# CLI Tools

ts-pantry provides a comprehensive set of command-line tools for working with pkgx packages using a pantry-based approach.

## Command Overview

ts-pantry offers several CLI commands:

```bash
# Fetch a single package
ts-pantry fetch node

# Fetch multiple specific packages
ts-pantry fetch --pkg node,bun,python

# Fetch all packages
ts-pantry fetch --all

# Update local pantry
ts-pantry update-pantry

# Generate constants file
ts-pantry generate-consts

# Generate package index
ts-pantry generate-index

# Generate TypeScript from cached JSON
ts-pantry generate-ts

# Generate aliases file
ts-pantry generate-aliases

# Generate package documentation
ts-pantry generate-docs

# Show version information
ts-pantry version
```

You can also use the Bun scripts:

```bash
# Bun script alternatives
bun run pkgx:fetch node
bun run pkgx:fetch-all
bun run pkgx:docs
```

## Single Package Fetching

Fetch information about a single package using the pantry-based approach:

```bash
# Basic usage
ts-pantry fetch node

# With custom options
ts-pantry fetch nodejs.org --output-dir ./custom-dir --timeout 60000

# Save as JSON instead of TypeScript
ts-pantry fetch bun --json

# With debugging enabled
ts-pantry fetch rust-lang.org --debug --verbose

# Nested packages
ts-pantry fetch agwa.name/git-crypt
```

This command fetches information from the local pantry and generates comprehensive TypeScript files with JSDoc documentation.

## Multiple Package Fetching

Fetch multiple packages at once using the `--pkg` option:

```bash
# Fetch multiple packages
ts-pantry fetch --pkg node,bun,python

# With custom options
ts-pantry fetch --pkg "go.dev,rust-lang.org" --json --timeout 60000

# Include nested packages
ts-pantry fetch --pkg "node,agwa.name/git-crypt,aws.amazon.com/cli"

# CI integration
ts-pantry fetch --pkg "node,bun,python" --output-json
```

This allows you to fetch a specific set of packages in a single command with intelligent caching.

## Bulk Fetching

Fetch all available packages from the local pantry:

```bash
# Default settings
ts-pantry fetch --all

# With custom options
ts-pantry fetch --all --output-dir ./data/packages --timeout 60000

# Limit the number of packages (for testing)
ts-pantry fetch --all --limit 50

# Control concurrency for performance
ts-pantry fetch --all --concurrency 12

# Conservative settings for slow networks
ts-pantry fetch --all --concurrency 4 --timeout 120000
```

## Pantry Management

Manage the local pantry for package information:

```bash
# Download and extract latest pantry
ts-pantry update-pantry

# Use custom pantry directory
ts-pantry update-pantry --pantry-dir ./my-pantry

# Generate constants file from pantry
ts-pantry generate-consts --source pantry

# Generate constants from S3 registry (alternative)
ts-pantry generate-consts --source registry --validate

# Use custom pantry location
ts-pantry generate-consts --pantry-dir ./my-pantry
```

## Caching Options

ts-pantry provides sophisticated caching capabilities:

```bash
# Use custom cache directory
ts-pantry fetch --all --cache-dir ./my-cache

# Disable caching for fresh data
ts-pantry fetch --all --no-cache

# Set custom cache expiration time (in minutes)
ts-pantry fetch --all --cache-expiration 30

# Use longer cache for CI environments
ts-pantry fetch --all --cache-expiration 1440  # 24 hours
```

## Index Generation

Generate the TypeScript index file for all packages with comprehensive JSDoc:

```bash
# Generate index with default settings
ts-pantry generate-index

# With custom output directory
ts-pantry generate-index --output-dir ./custom/packages
```

The generated index includes:

- Comprehensive JSDoc documentation for each package
- Alias properties for easy access
- Type-safe property names
- Links to package documentation

## TypeScript Generation

Convert cached JSON files to TypeScript with enhanced documentation:

```bash
# Convert cached JSON to TypeScript
ts-pantry generate-ts

# With custom directories
ts-pantry generate-ts --cache-dir ./custom-cache --output-dir ./ts-packages
```

This generates TypeScript files with:

- Rich JSDoc documentation
- Alias-based variable naming
- Comprehensive type information
- Links to documentation

## Aliases Generation

Generate a TypeScript file with package aliases:

```bash
# Generate aliases file
ts-pantry generate-aliases
```

## Documentation Generation

Generate comprehensive BunPress documentation of all packages:

```bash
# Generate package documentation with default settings
ts-pantry generate-docs

# Custom output directory
ts-pantry generate-docs --output-dir ./custom-docs
```

This creates well-organized documentation with:

- Package categorization
- Complete package information
- Installation instructions
- Links to source code and homepages

## Advanced CLI Options

The CLI commands support various advanced options:

```bash
# Performance tuning
ts-pantry fetch --all --concurrency 15 --timeout 30000

# Debug mode with verbose output
ts-pantry fetch node --debug --verbose

# CI integration with structured JSON output
ts-pantry fetch --pkg "node,bun,python" --output-json

# Conservative settings for unreliable networks
ts-pantry fetch --all --timeout 180000 --max-retries 5
```

## Compiled Binaries

For faster execution, ts-pantry can be compiled to binaries for different platforms:

```bash
# Compile for the current platform
bun run compile

# Compile for all supported platforms
bun run compile:all

# Available platforms
# - Linux x64/ARM64
# - Windows x64
# - macOS x64/ARM64
```

The resulting binaries can be distributed and used without requiring Bun or Node.js to be installed.

## Environment Configuration

Configure CLI behavior through environment variables:

```bash
# Enable debug mode
DEBUG=true ts-pantry fetch node

# Set NODE_ENV for different behaviors
NODE_ENV=production ts-pantry fetch --all
```

## CI/CD Integration

The CLI commands are designed for CI/CD environments:

```bash
# Get structured JSON output for parsing
result=$(ts-pantry fetch --pkg "node,bun,python" --output-json)

# Parse results in CI scripts
echo "$result" | jq '.success'
echo "$result" | jq -r '.updatedPackages[]'

# Fail CI if packages couldn't be fetched
ts-pantry fetch --pkg "required-packages" --output-json | jq -e '.success'
```

## Integration with Build Systems

The CLI commands can be integrated into build systems:

```json
// package.json
{
  "scripts": {
    "update:pantry": "ts-pantry update-pantry",
    "update:packages": "ts-pantry fetch --all",
    "update:specific": "ts-pantry fetch --pkg node,bun,python",
    "generate:docs": "ts-pantry generate-docs",
    "generate:consts": "ts-pantry generate-consts",
    "build": "npm run update:packages && npm run generate:docs"
  }
}
```

## Performance Optimization

Optimize CLI performance for different scenarios:

```bash
# High-performance setup (good network, powerful machine)
ts-pantry fetch --all --concurrency 15 --timeout 30000 --cache-expiration 60

# Conservative setup (slower network or machine)
ts-pantry fetch --all --concurrency 4 --timeout 120000 --cache-expiration 1440

# Testing setup (quick validation)
ts-pantry fetch --all --limit 20 --concurrency 8 --verbose

# Development setup (frequent updates)
ts-pantry fetch --all --cache-expiration 10 --debug
```

## Error Handling and Debugging

Troubleshoot issues with enhanced debugging:

```bash
# Enable verbose output for troubleshooting
ts-pantry fetch problematic-package --verbose

# Full debug mode with screenshots
ts-pantry fetch problematic-package --debug --verbose

# Increase timeout for slow packages
ts-pantry fetch slow-package --timeout 180000

# Disable cache to get fresh data
ts-pantry fetch problematic-package --no-cache
```

## Resource Management

The CLI automatically manages browser resources and includes safety mechanisms:

- **Automatic cleanup**: Browser resources are cleaned up after operations
- **Force exit timeout**: Prevents hung processes (25-minute maximum runtime)
- **Signal handling**: Graceful shutdown on SIGINT/SIGTERM
- **Memory management**: Optimized for handling large numbers of packages
