# bison

> Parser generator

## Package Information

- **Domain**: `gnu.org/bison`
- **Name**: `bison`
- **Homepage**: <https://www.gnu.org/software/bison/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/gnu.org/bison/package.yml)

## Installation

```bash
# Install with pantry
pantry install gnu.org/bison
```

## Programs

This package provides the following executable programs:

- `bison`
- `yacc`

## Available Versions

<details>
<summary>Show all 50 versions</summary>

- `3.8.2`, `3.8.1`, `3.8`
- `3.7.91`, `3.7.90`, `3.7.6`, `3.7.5`, `3.7.4`, `3.7.3`, `3.7.2`, `3.7.1`, `3.7`
- `3.6.93`, `3.6.92`, `3.6.91`, `3.6.90`, `3.6.4`, `3.6.3`, `3.6.2`, `3.6.1`, `3.6`
- `3.5.94`, `3.5.93`, `3.5.92`, `3.5.91`, `3.5.90`, `3.5.4`, `3.5.3`, `3.5.2`, `3.5.1`, `3.5`
- `3.4.92`, `3.4.91`, `3.4.90`, `3.4.2`, `3.4.1`, `3.4`
- `3.3.91`, `3.3.90`, `3.3.2`, `3.3.1`, `3.3`
- `3.2.91`, `3.2.90`, `3.2.4`, `3.2.3`, `3.2.2`, `3.2.1.0`, `3.2.1`, `3.2`

</details>

**Latest Version**: `3.8.2`

### Install Specific Version

```bash
# Install a specific version
pantry install gnu.org/bison@3.8.2
```

## Dependencies

This package depends on:

- `gnu.org/m4@1`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.bison

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/gnu.org/bison/package.yml)
- [Homepage](https://www.gnu.org/software/bison/)
- [Back to Package Catalog](../../../package-catalog.md)

---

> Auto-generated from package data.
