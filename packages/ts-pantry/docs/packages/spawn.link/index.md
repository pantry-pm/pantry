# spawn.link

> a featureful union filesystem

## Package Information

- **Domain**: `spawn.link`
- **Name**: `spawn.link`
- **Homepage**: <https://trapexit.github.io/mergerfs/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/spawn.link/package.yml)

## Installation

```bash
# Install with pantry
pantry install spawn.link
```

## Programs

This package provides the following executable programs:

- `mergerfs`
- `mergerfs-fusermount`
- `mount.mergerfs`

## Available Versions

<details>
<summary>Show all 49 versions</summary>

- `2.42.0`
- `2.41.1`, `2.41.0`
- `2.40.2`, `2.40.1`, `2.40.0`
- `2.39.0`
- `2.38.0`
- `2.37.1`, `2.37.0`
- `2.36.0`
- `2.35.1`, `2.35.0`
- `2.34.1`, `2.34.0`
- `2.33.5`, `2.33.4`, `2.33.3`, `2.33.2`, `2.33.1`, `2.33.0`
- `2.32.6`, `2.32.5`, `2.32.4`, `2.32.3`, `2.32.2`, `2.32.1`
- `2.31.0`
- `2.30.0`
- `2.29.0`
- `2.28.3`, `2.28.2`, `2.28.1`, `2.28.0`
- `2.27.1`, `2.27.0`
- `2.26.2`, `2.26.1`, `2.26.0`
- `2.25.1`
- `2.24.2`, `2.24.1`, `2.24.0`
- `2.23.1`, `2.23.0`
- `2.22.1`, `2.22.0`
- `2.21.0`
- `2.20.0`

</details>

**Latest Version**: `2.42.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +spawn.link@2.42.0 -- $SHELL -i
```

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry['spawn.link']

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/spawn.link/package.yml)
- [Homepage](https://trapexit.github.io/mergerfs/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
