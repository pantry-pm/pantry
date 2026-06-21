# pip

> The Python package installer

## Package Information

- **Domain**: `pip.pypa.io`
- **Name**: `pip`
- **Homepage**: <https://pip.pypa.io/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/pip.pypa.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install pip.pypa.io
```

## Programs

This package provides the following executable programs:

- `pip`
- `pip3.8`
- `pip3.9`
- `pip3.10`
- `pip3.11`

## Available Versions

<details>
<summary>Show all 68 versions</summary>

- `26.1.2`, `26.1.1`, `26.1`
- `26.0.1`, `26.0`, `26.0.0`
- `25.3`, `25.3.0`
- `25.2`, `25.2.0`
- `25.1.1`, `25.1`, `25.1.0`
- `25.0.1`, `25.0`, `25.0.0`
- `24.3.1`, `24.3`, `24.3.0`
- `24.2`, `24.2.0`
- `24.1.2`, `24.1.1`, `24.1`, `24.1.0`
- `24.1b2`
- `24.1b1`
- `24.0`, `24.0.0`
- `23.3.2`, `23.3.1`, `23.3`, `23.3.0`
- `23.2.1`, `23.2`, `23.2.0`
- `23.1.2`, `23.1.1`, `23.1`, `23.1.0`
- `23.0.1`, `23.0`, `23.0.0`
- `22.3.1`, `22.3`, `22.3.0`
- `22.2.2`, `22.2.1`, `22.2`
- `22.1.2`, `22.1.1`, `22.1`
- `22.1b1`
- `22.0.4`, `22.0.3`, `22.0.2`, `22.0.1`, `22.0`
- `21.3.1`, `21.3`
- `21.2.4`, `21.2.3`, `21.2.2`, `21.2.1`, `21.2`
- `20.3.4`
- `19.3.1`
- `18.1.0`

</details>

**Latest Version**: `26.1.2`

### Install Specific Version

```bash
# Install a specific version
pantry install pip.pypa.io@26.1.2
```

## Dependencies

This package depends on:

- `pkgx.sh>=1`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.pip

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/pip.pypa.io/package.yml)
- [Homepage](https://pip.pypa.io/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
