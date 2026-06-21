# kubectl-krew

> 📦 Find and install kubectl plugins

## Package Information

- **Domain**: `krew.sigs.k8s.io`
- **Name**: `kubectl-krew`
- **Homepage**: <https://sigs.k8s.io/krew/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/krew.sigs.k8s.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install krew.sigs.k8s.io
```

## Programs

This package provides the following executable programs:

- `kubectl-krew`

## Available Versions

<details>
<summary>Show all 15 versions</summary>

- `0.5.0`
- `0.4.5`, `0.4.4`, `0.4.3`, `0.4.2`, `0.4.1`, `0.4.0`
- `0.3.4`, `0.3.3`, `0.3.2`, `0.3.1`, `0.3.0`
- `0.2.1`, `0.2.0`
- `0.1.1`

</details>

**Latest Version**: `0.5.0`

### Install Specific Version

```bash
# Install a specific version
pantry install krew.sigs.k8s.io@0.5.0
```

## Dependencies

This package depends on:

- `git-scm.org`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry['kubectl-krew']

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/krew.sigs.k8s.io/package.yml)
- [Homepage](https://sigs.k8s.io/krew/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
