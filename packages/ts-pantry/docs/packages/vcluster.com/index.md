# vcluster

> vCluster - Create fully functional virtual Kubernetes clusters - Each vcluster runs inside a namespace of the underlying k8s cluster. It's cheaper than creating separate full-blown clusters and it offers better multi-tenancy and isolation than regular namespaces.

## Package Information

- **Domain**: `vcluster.com`
- **Name**: `vcluster`
- **Homepage**: <https://www.vcluster.com>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/vcluster.com/package.yml)

## Installation

```bash
# Install with pantry
pantry install vcluster.com
```

## Programs

This package provides the following executable programs:

- `vcluster`

## Available Versions

<details>
<summary>Show all 36 versions</summary>

- `0.35.1`, `0.35.0`
- `0.34.5`, `0.34.4`, `0.34.3`, `0.34.2`, `0.34.1`, `0.34.0`
- `0.33.4`, `0.33.3`, `0.33.2`, `0.33.1`, `0.33.0`
- `0.32.3`, `0.32.2`, `0.32.1`, `0.32.0`
- `0.31.3`, `0.31.2`, `0.31.1`, `0.31.0`
- `0.30.5`, `0.30.4`, `0.30.3`, `0.30.2`, `0.30.1`, `0.30.0`
- `0.29.3`, `0.29.2`, `0.29.1`, `0.29.0`
- `0.28.2`, `0.28.1`, `0.28.0`
- `0.27.3`, `0.27.2`

</details>

**Latest Version**: `0.35.1`

### Install Specific Version

```bash
# Install a specific version
pantry install vcluster.com@0.35.1
```

## Dependencies

This package depends on:

- `kubernetes.io/kubectl^1`
- `linux:curl.se/ca-certs`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.vcluster

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/vcluster.com/package.yml)
- [Homepage](https://www.vcluster.com)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
