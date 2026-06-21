# ccache

> Object-file caching compiler wrapper

## Package Information

- **Domain**: `ccache.dev`
- **Name**: `ccache`
- **Homepage**: <https://ccache.dev/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/ccache.dev/package.yml)

## Installation

```bash
# Install with pantry
pantry install ccache.dev
```

## Programs

This package provides the following executable programs:

- `ccache`

## Available Versions

<details>
<summary>Show all 58 versions</summary>

- `4.13.6`, `4.13.5`, `4.13.4`, `4.13.3`, `4.13.2`, `4.13.1`, `4.13`, `4.13.0`
- `4.12.3`, `4.12.2`, `4.12.1`, `4.12`, `4.12.0`
- `4.11.3`, `4.11.2`, `4.11.1`, `4.11`, `4.11.0`
- `4.10.2`, `4.10.1`, `4.10`, `4.10.0`
- `4.9.1`, `4.9`
- `4.8.3`, `4.8.2`, `4.8.1`, `4.8`
- `4.7.5`, `4.7.4`, `4.7.3`, `4.7.2`, `4.7.1`, `4.7`
- `4.6.3`, `4.6.2`, `4.6.1`, `4.6`
- `4.5.1`, `4.5`
- `4.4.2`, `4.4.1`, `4.4`
- `4.3`
- `4.2.1`, `4.2`
- `4.1`
- `4.0`
- `3.7.12`, `3.7.11`, `3.7.10`, `3.7.9`, `3.7.8`, `3.7.7`, `3.7.6`, `3.7.5`, `3.7.4`, `3.7.3`

</details>

**Latest Version**: `4.13.6`

### Install Specific Version

```bash
# Install a specific version
pantry install ccache.dev@4.13.6
```

## Dependencies

This package depends on:

- `github.com/redis/hiredis`
- `facebook.com/zstd`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.ccache

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/ccache.dev/package.yml)
- [Homepage](https://ccache.dev/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
