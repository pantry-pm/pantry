# openbao

> OpenBao exists to provide a software solution to manage, store, and distribute sensitive data including secrets, certificates, and keys.

## Package Information

- **Domain**: `openbao.org/openbao`
- **Name**: `openbao`
- **Homepage**: <https://openbao.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/openbao.org/openbao/package.yml)

## Installation

```bash
# Install with pantry
pantry install openbao.org/openbao
```

## Programs

This package provides the following executable programs:

- `bao`
- `bao-setup`

## Available Versions

<details>
<summary>Show all 22 versions</summary>

- `2.5.5`, `2.5.4`, `2.5.3`, `2.5.2`, `2.5.1`, `2.5.0`
- `2.4.4`, `2.4.3`, `2.4.1`, `2.4.0`
- `2.3.2`, `2.3.1`
- `2.2.2`, `2.2.1`, `2.2.0`, `2.2.0-beta20250213`
- `2.1.1`, `2.1.0`
- `2.0.3`, `2.0.2`, `2.0.1`, `2.0.0`

</details>

**Latest Version**: `2.5.5`

### Install Specific Version

```bash
# Install a specific version
pantry install openbao.org/openbao@2.5.5
```

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.openbao

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/openbao.org/openbao/package.yml)
- [Homepage](https://openbao.org/)
- [Back to Package Catalog](../../../package-catalog.md)

---

> Auto-generated from package data.
