# volta

> JavaScript toolchain manager for reproducible environments

## Package Information

- **Domain**: `volta.sh`
- **Name**: `volta`
- **Homepage**: <https://volta.sh>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/volta.sh/package.yml)

## Installation

```bash
# Install with pantry
pantry install volta.sh
```

## Programs

This package provides the following executable programs:

- `volta`

## Available Versions

<details>
<summary>Show all 18 versions</summary>

- `2.0.2`, `2.0.1`, `2.0.0`
- `1.1.1`, `1.1.0`
- `1.0.8`, `1.0.7`, `1.0.6`, `1.0.5`, `1.0.4`, `1.0.3`, `1.0.2`, `1.0.1`, `1.0.0`
- `0.9.3`, `0.9.2`, `0.9.1`, `0.9.0`

</details>

**Latest Version**: `2.0.2`

### Install Specific Version

```bash
# Install a specific version
pantry install volta.sh@2.0.2
```

## Dependencies

This package depends on:

- `linux:curl.se/ca-certs`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.volta

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/volta.sh/package.yml)
- [Homepage](https://volta.sh)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
