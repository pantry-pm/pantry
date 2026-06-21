# onefetch

> Command-line Git information tool

## Package Information

- **Domain**: `onefetch.dev`
- **Name**: `onefetch`
- **Homepage**: <https://onefetch.dev/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/onefetch.dev/package.yml)

## Installation

```bash
# Install with pantry
pantry install onefetch.dev
```

## Programs

This package provides the following executable programs:

- `onefetch`

## Available Versions

<details>
<summary>Show all 41 versions</summary>

- `2.27.1`, `2.27.0`
- `2.26.1`, `2.26.0`
- `2.25.0`
- `2.24.0`
- `2.23.1`, `2.23.0`
- `2.22.0`
- `2.21.0`
- `2.20.0`
- `2.19.0`
- `2.18.1`
- `2.13.2`, `2.13.1`, `2.13.0`
- `2.12.0`
- `2.11.0`
- `2.10.2`, `2.10.1`, `2.10.0`
- `2.9.1`, `2.9.0`
- `2.8.0`
- `2.7.3`, `2.7.2`, `2.7.1`, `2.7.0`
- `2.6.0`
- `2.5.0`
- `2.4.0`
- `2.3.0`
- `2.2.0`
- `2.1.0`
- `2.0.1`, `2.0.0`
- `1.7.0`
- `1.6.5`, `1.6.0`
- `1.5.5`, `1.5.4`

</details>

**Latest Version**: `2.27.1`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +onefetch.dev@2.27.1 -- $SHELL -i
```

## Dependencies

This package depends on:

- `libgit2.org~1.7 # links to libgit2.so.1.7`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.onefetch

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/onefetch.dev/package.yml)
- [Homepage](https://onefetch.dev/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
