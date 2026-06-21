# fury

> Gemfury CLI

## Package Information

- **Domain**: `fury.co`
- **Name**: `fury`
- **Homepage**: <https://fury.co/guide/cli>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/fury.co/package.yml)

## Installation

```bash
# Install with pantry
pantry install fury.co
```

## Programs

This package provides the following executable programs:

- `fury`

## Available Versions

<details>
<summary>Show all 10 versions</summary>

- `0.23.0`
- `0.22.0`
- `0.21.0`
- `0.20.2`, `0.20.1`, `0.20.0-beta.3`, `0.20.0-beta.2`, `0.20.0-rc.1`, `0.20.0-beta.1`, `0.20.0`

</details>

**Latest Version**: `0.23.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +fury.co@0.23.0 -- $SHELL -i
```

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.fury

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/fury.co/package.yml)
- [Homepage](https://fury.co/guide/cli)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
