# CLI Reference

ts-pantry provides a powerful command-line interface for working with Pantry packages. This page documents all the available commands and their options.

## Installation

The CLI commands are available when you install ts-pantry:

```bash
bun install ts-pantry
```

## Commands Overview

| Command | Description |
|---------|-------------|
| `ts-pantry fetch [packageName]` | Fetch a single package, multiple packages, or all packages |
| `ts-pantry resolve-deps [file]` | Resolve dependency files and find all transitive dependencies |
| `ts-pantry generate-index` | Generate TypeScript index file for packages |
| `ts-pantry generate-ts` | Generate TypeScript files from cached JSON |
| `ts-pantry generate-aliases` | Generate TypeScript aliases file for packages |
| `ts-pantry generate-docs` | Generate comprehensive BunPress documentation for all packages |
| `ts-pantry update-pantry` | Download and extract the latest pantry.tgz file |
| `ts-pantry generate-consts` | Generate or update the consts.ts file with all known packages |
| `ts-pantry version` | Display version information |

## fetch Command

The `fetch` command retrieves package information from Pantry for one or more packages using the pantry-based approach.

### Usage

```bash
# Fetch a single package
ts-pantry fetch [packageName] [options]

# Fetch multiple specific packages
ts-pantry fetch --pkg <packageNames> [options]

# Fetch all packages
ts-pantry fetch --all [options]
```

### Arguments

- `packageName`: Optional name of a single package to fetch (e.g., 'node', 'bun.sh', 'agwa.name/git-crypt')

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-a, --all` | Fetch all packages | `false` |
| `-p, --pkg <packageNames>` | Comma-separated list of package names to fetch | - |
| `-o, --output-dir <dir>` | Directory to save package data | `src/packages` |
| `-c, --cache-dir <dir>` | Directory to cache package data | `.cache/packages` |
| `-n, --no-cache` | Disable caching | `false` |
| `-e, --cache-expiration <minutes>` | Cache expiration time in minutes | `1440` (24 hours) |
| `-l, --limit <count>` | Limit the number of packages to fetch (use with --all) | - |
| `-t, --timeout <ms>` | Timeout for network requests in milliseconds | `20000` |
| `-r, --max-retries <count>` | Maximum retry attempts for failed requests | `3` |
| `-j, --json` | Save as JSON instead of TypeScript | `false` |
| `-d, --debug` | Enable debug mode (save screenshots) | `false` |
| `-v, --verbose` | Enable verbose output | `false` |
| `-y, --concurrency <count>` | Number of packages to fetch concurrently | `8` |
| `--output-json` | Output results as JSON (for CI integration) | `false` |

### Examples

```bash
# Fetch a single package
ts-pantry fetch node

# Fetch a package with specific path
ts-pantry fetch agwa.name/git-crypt

# Fetch multiple packages
ts-pantry fetch --pkg node,bun,python

# Fetch packages with custom output directory and timeout
ts-pantry fetch --pkg "nodejs.org,python.org" --output-dir ./custom-packages --timeout 60000

# Save as JSON instead of TypeScript
ts-pantry fetch --pkg "go.dev,rust-lang.org" --json

# Fetch all packages with a limit
ts-pantry fetch --all --limit 50

# Fetch with increased concurrency and verbose output
ts-pantry fetch --all --concurrency 12 --verbose

# Fetch with custom cache settings
ts-pantry fetch --all --cache-expiration 120 --no-cache

# Output JSON for CI integration
ts-pantry fetch --pkg "node,bun,python" --output-json
```

## resolve-deps Command

The `resolve-deps` command analyzes dependency files and resolves all transitive dependencies with version conflict resolution.

### Usage

```bash
# Resolve a specific dependency file
ts-pantry resolve-deps [file] [options]

# Find and resolve all dependency files in a directory
ts-pantry resolve-deps --find-files [directory] [options]
```

### Arguments

- `file`: Optional path to a dependency file (e.g., 'deps.yaml', 'pkgx.yaml', 'dependencies.yml')

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-d, --dir <directory>` | Directory to search for dependency files | `.` |
| `--find-files` | Find and resolve all dependency files in the directory | `false` |
| `--pantry-dir <dir>` | Directory containing pantry files | `src/pantry` |
| `--packages-dir <dir>` | Directory containing generated package files | `src/packages` |
| `--target-os <os>` | Target OS for OS-specific dependencies (linux, darwin, windows) | - |
| `--include-os-deps` | Include OS-specific dependencies | `false` |
| `--max-depth <depth>` | Maximum recursion depth for transitive dependencies | `10` |
| `-v, --verbose` | Enable verbose output | `false` |
| `-j, --json` | Output results as JSON | `false` |
| `--install-command` | Show install command for all unique packages | `false` |

### Examples

```bash
# Resolve a single dependency file
ts-pantry resolve-deps deps.yaml

# Resolve with verbose output and install command
ts-pantry resolve-deps pkgx.yaml --verbose --install-command

# Find all dependency files in a project
ts-pantry resolve-deps --find-files ./my-project

# Output as JSON for automation
ts-pantry resolve-deps deps.yaml --json

# Filter for specific OS
ts-pantry resolve-deps deps.yaml --target-os darwin --include-os-deps

# Custom configuration
ts-pantry resolve-deps deps.yaml --pantry-dir ./custom-pantry --max-depth 5
```

### Supported File Formats

The resolver supports these dependency file formats:

- `deps.yaml` / `deps.yml`
- `dependencies.yaml` / `dependencies.yml`
- `pkgx.yaml` / `pkgx.yml`

Example dependency file:

```yaml
dependencies:
  bun.sh: ^1.2.16
  nodejs.org: ^20.0.0
  python.org: 3.9.0
  git-scm.org: latest
```

### Output Format

The command provides detailed output including:

- All unique packages to install with resolved versions
- Version conflicts detected and resolved
- OS-specific dependencies (when enabled)
- Install commands for package managers
- Statistics about dependency resolution

## generate-index Command

Generate a TypeScript index file for packages with comprehensive JSDoc documentation and alias support.

### Usage

```bash
ts-pantry generate-index [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-o, --output-dir <dir>` | Directory containing package files | `src/packages` |

### Examples

```bash
# Generate index with default settings
ts-pantry generate-index

# With custom output directory
ts-pantry generate-index --output-dir ./custom/packages
```

## generate-ts Command

Generate TypeScript files from cached JSON files.

### Usage

```bash
ts-pantry generate-ts [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--cache-dir <dir>` | Directory with cached JSON files | `.cache/packages` |
| `--output-dir <dir>` | Output directory for TypeScript files | `packages` |

### Examples

```bash
# Generate TypeScript from cached JSON
ts-pantry generate-ts

# With custom directories
ts-pantry generate-ts --cache-dir ./custom-cache --output-dir ./custom-output
```

## generate-aliases Command

Generate a TypeScript aliases file for packages.

### Usage

```bash
ts-pantry generate-aliases
```

### Examples

```bash
# Generate aliases file
ts-pantry generate-aliases
```

## generate-docs Command

Generate comprehensive BunPress documentation for all packages.

### Usage

```bash
ts-pantry generate-docs [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-o, --output-dir <dir>` | Output directory for documentation | `docs` |

### Examples

```bash
# Generate documentation with default settings
ts-pantry generate-docs

# Generate documentation with custom output directory
ts-pantry generate-docs --output-dir ./custom-docs
```

## update-pantry Command

Download and extract the latest pantry.tgz file from the pkgx distribution.

### Usage

```bash
ts-pantry update-pantry [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-d, --pantry-dir <dir>` | Directory to extract pantry files | `src/pantry` |

### Examples

```bash
# Update pantry with default settings
ts-pantry update-pantry

# Update pantry to custom directory
ts-pantry update-pantry --pantry-dir ./my-pantry
```

## generate-consts Command

Generate or update the consts.ts file with all known packages from either the local pantry or S3 registry.

### Usage

```bash
ts-pantry generate-consts [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --source <source>` | Source for packages: "pantry" or "registry" | `pantry` |
| `--pantry-dir <dir>` | Directory containing pantry files | `src/pantry` |
| `--validate` | Validate a sample of packages (slower but more accurate) | `false` |

### Examples

```bash
# Generate consts from local pantry
ts-pantry generate-consts

# Generate consts from S3 registry
ts-pantry generate-consts --source registry

# Generate with validation
ts-pantry generate-consts --source registry --validate

# Use custom pantry directory
ts-pantry generate-consts --pantry-dir ./my-pantry
```

## Using with Bun Scripts

You can also use the pre-configured Bun scripts:

```bash
# Fetch commands
bun run pkgx:fetch node
bun run pkgx:fetch-all

# Generate documentation
bun run pkgx:docs
```

## Using Compiled Binaries

For faster execution, you can use the compiled binaries that are distributed with the package:

```bash
# Run directly from bin directory
./bin/ts-pantry fetch node

# Create a symlink in your path
ln -s $(pwd)/bin/ts-pantry /usr/local/bin/ts-pantry
ts-pantry fetch node
```

## Type Safety Features

The CLI commands work seamlessly with ts-pantry's comprehensive type safety features:

```bash
# Type-safe package names are validated at runtime
ts-pantry fetch node          # ✅ Valid alias
ts-pantry fetch nodejs.org    # ✅ Valid domain
ts-pantry fetch invalid-pkg   # ❌ Will show error for invalid package

# Nested package paths are supported
ts-pantry fetch agwa.name/git-crypt  # ✅ Valid nested package
```

## CI Integration

Use the `--output-json` flag for CI integration:

```bash
# Output structured JSON for CI systems
ts-pantry fetch --pkg "node,bun,python" --output-json
```

This outputs structured JSON with information about processed packages, friendly names, and success status.

## Environment Variables

ts-pantry respects the following environment variables:

- `DEBUG`: Set to `true` to enable debug mode
- `NODE_ENV`: Affects logging behavior

## Advanced Usage

### Cache Management

Control caching behavior for better performance:

```bash
# Use fresh data (disable cache)
ts-pantry fetch --all --no-cache

# Custom cache expiration (in minutes)
ts-pantry fetch --all --cache-expiration 60

# Custom cache directory
ts-pantry fetch --all --cache-dir ./my-cache
```

### Performance Tuning

Optimize performance for large operations:

```bash
# Increase concurrency for faster fetching
ts-pantry fetch --all --concurrency 20

# Set longer timeout for slow networks
ts-pantry fetch --all --timeout 60000

# Limit packages for testing
ts-pantry fetch --all --limit 10
```

### Development and Debugging

Enable debugging and verbose output:

```bash
# Enable debug mode (saves screenshots)
ts-pantry fetch node --debug

# Verbose output for detailed logging
ts-pantry fetch --pkg "node,bun" --verbose

# Both debug and verbose
ts-pantry fetch --all --debug --verbose --limit 5
```
