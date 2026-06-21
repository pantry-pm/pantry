# apktool

> Tool for reverse engineering 3rd party, closed, binary Android apps

## Package Information

- **Domain**: `apktool.org`
- **Name**: `apktool`
- **Homepage**: <https://apktool.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/apktool.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install apktool.org
```

## Programs

This package provides the following executable programs:

- `apktool`

## Available Versions

<details>
<summary>Show all 29 versions</summary>

- `3.0.2`, `3.0.1`
- `2.12.1`, `2.12.0`
- `2.11.1`, `2.11.0`
- `2.10.0`
- `2.9.3`, `2.9.2`, `2.9.1`, `2.9.0`
- `2.8.1`, `2.8.0`
- `2.7.0`
- `2.6.1`, `2.6.0`
- `2.5.0`
- `2.4.1`, `2.4.0`
- `2.3.4`, `2.3.3`, `2.3.2`, `2.3.1`, `2.3.0`
- `2.2.4`, `2.2.3`, `2.2.2`, `2.2.1`
- `2.0.3`

</details>

**Latest Version**: `3.0.2`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +apktool.org@3.0.2 -- $SHELL -i
```

## Dependencies

This package depends on:

- `openjdk.org^21`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.apktool

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/apktool.org/package.yml)
- [Homepage](https://apktool.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
