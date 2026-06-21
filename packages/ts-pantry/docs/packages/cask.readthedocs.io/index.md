# cask

> Project management tool for Emacs

## Package Information

- **Domain**: `cask.readthedocs.io`
- **Name**: `cask`
- **Homepage**: <https://cask.readthedocs.io/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/cask.readthedocs.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install cask.readthedocs.io
```

## Programs

This package provides the following executable programs:

- `cask`

## Available Versions

<details>
<summary>Show all 34 versions</summary>

- `0.9.1`, `0.9.0`
- `0.8.8`, `0.8.7`, `0.8.6`, `0.8.5`, `0.8.4`, `0.8.3`, `0.8.2`, `0.8.1`, `0.8.0`
- `0.7.4`, `0.7.3`, `0.7.2`, `0.7.1`, `0.7.0`
- `0.6.0`
- `0.5.2`, `0.5.1`, `0.5.0`
- `0.4.6`, `0.4.5`, `0.4.4`, `0.4.3`, `0.4.2`, `0.4.1`, `0.4.0`
- `0.3.1`, `0.3.0`
- `0.2.0`
- `0.1.2`, `0.1.1`, `0.1.0`
- `0.0.2`

</details>

**Latest Version**: `0.9.1`

### Install Specific Version

```bash
# Install a specific version
pantry install cask.readthedocs.io@0.9.1
```

## Dependencies

This package depends on:

- `gnu.org/coreutils`
- `gnu.org/emacs`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.cask

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/cask.readthedocs.io/package.yml)
- [Homepage](https://cask.readthedocs.io/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
