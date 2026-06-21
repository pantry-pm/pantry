# Pearcleaner

> Open-source application uninstaller for macOS.

## Package Information

- **Domain**: `pearcleaner.app`
- **Name**: `Pearcleaner`
- **Homepage**: <https://github.com/alienator88/Pearcleaner>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/pearcleaner.app/package.yml)

## Installation

```bash
# Install with pantry
pantry install pearcleaner.app
```

## Programs

This package provides the following executable programs:

No programs specified.

## Available Versions

<details>
<summary>Show all 1 versions</summary>

- `5.4.3`

</details>

**Latest Version**: `5.4.3`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +pearcleaner.app@5.4.3 -- $SHELL -i
```

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.Pearcleaner

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/pearcleaner.app/package.yml)
- [Homepage](https://github.com/alienator88/Pearcleaner)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
