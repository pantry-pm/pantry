# velero

> Backup and migrate Kubernetes applications and their persistent volumes

## Package Information

- **Domain**: `velero.io`
- **Name**: `velero`
- **Homepage**: <https://velero.io/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/velero.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install velero.io
```

## Programs

This package provides the following executable programs:

- `velero`

## Available Versions

<details>
<summary>Show all 21 versions</summary>

- `1.18.1`, `1.18.0`
- `1.17.2`, `1.17.1`, `1.17.0`
- `1.16.2`, `1.16.1`, `1.16.0`
- `1.15.2`, `1.15.1`, `1.15.0`
- `1.14.1`, `1.14.0`
- `1.13.2`, `1.13.1`, `1.13.0`
- `1.12.4`, `1.12.3`, `1.12.2`, `1.12.1`, `1.12.0`

</details>

**Latest Version**: `1.18.1`

### Install Specific Version

```bash
# Install a specific version
pantry install velero.io@1.18.1
```

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.velero

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/velero.io/package.yml)
- [Homepage](https://velero.io/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
