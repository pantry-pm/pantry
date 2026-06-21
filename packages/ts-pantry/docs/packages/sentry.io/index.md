# sentry-cli

> Command-line utility to interact with Sentry

## Package Information

- **Domain**: `sentry.io`
- **Name**: `sentry-cli`
- **Homepage**: <https://docs.sentry.io/cli/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/sentry.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install sentry.io
```

## Programs

This package provides the following executable programs:

- `sentry-cli`

## Available Versions

<details>
<summary>Show all 53 versions</summary>

- `3.5.1`, `3.5.0`
- `3.4.3`, `3.4.2`, `3.4.1`, `3.4.0`
- `3.3.5`, `3.3.4`, `3.3.3`, `3.3.2`, `3.3.1`, `3.3.0`
- `3.2.3`, `3.2.2`, `3.2.1`, `3.2.0`
- `3.1.0`
- `3.0.3`, `3.0.2`, `3.0.1`, `3.0.0`
- `2.58.6`, `2.58.5`, `2.58.4`, `2.58.3`, `2.58.2`, `2.58.1`, `2.58.0`
- `2.57.0`
- `2.56.1`, `2.56.0`
- `2.55.0`
- `2.54.0`
- `2.53.0`
- `2.52.0`
- `2.51.1`, `2.51.0`
- `2.50.2`, `2.50.1`, `2.50.0`
- `2.49.0`
- `2.48.0`
- `2.47.1`, `2.47.0`
- `2.46.0`
- `2.45.0`
- `2.44.0`
- `2.43.1`, `2.43.0`
- `2.42.5`, `2.42.4`, `2.42.3`, `2.42.2`

</details>

**Latest Version**: `3.5.1`

### Install Specific Version

```bash
# Install a specific version
pantry install sentry.io@3.5.1
```

## Dependencies

This package depends on:

- `libgit2.org~1.7 # links to libgit2.so.1.7`
- `curl.se^8 # links to libcurl`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry['sentry-cli']

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/sentry.io/package.yml)
- [Homepage](https://docs.sentry.io/cli/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
