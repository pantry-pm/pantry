# k3d

> Little helper to run CNCF's k3s in Docker

## Package Information

- **Domain**: `k3d.io`
- **Name**: `k3d`
- **Homepage**: <https://k3d.io>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/k3d.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install k3d.io
```

## Programs

This package provides the following executable programs:

- `k3d`

## Available Versions

<details>
<summary>Show all 35 versions</summary>

- `5.9.0`
- `5.8.3`, `5.8.2`, `5.8.1`, `5.8.0`
- `5.7.5`, `5.7.4`, `5.7.3`, `5.7.2`, `5.7.1`, `5.7.0`
- `5.6.3`, `5.6.2`, `5.6.0`
- `5.5.2`, `5.5.1`, `5.5.0`
- `5.4.9`, `5.4.8`, `5.4.7`, `5.4.6`, `5.4.4`, `5.4.3`, `5.4.2`, `5.4.1`, `5.4.0`
- `5.3.0`
- `5.2.2`, `5.2.1`, `5.2.0`
- `5.1.0`
- `5.0.3`, `5.0.2`, `5.0.1`, `5.0.0`

</details>

**Latest Version**: `5.9.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +k3d.io@5.9.0 -- $SHELL -i
```

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.k3d

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/k3d.io/package.yml)
- [Homepage](https://k3d.io)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
