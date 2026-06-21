# htop

> Improved top (interactive process viewer)

## Package Information

- **Domain**: `htop.dev`
- **Name**: `htop`
- **Homepage**: <https://htop.dev/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/htop.dev/package.yml)

## Installation

```bash
# Install with pantry
pantry install htop.dev
```

## Programs

This package provides the following executable programs:

- `htop`

## Available Versions

<details>
<summary>Show all 18 versions</summary>

- `3.5.1`, `3.5.0`
- `3.4.1`, `3.4.0`
- `3.3.0`
- `3.2.2`, `3.2.1`, `3.2.0`
- `3.1.2`, `3.1.1`, `3.1.0`
- `3.0.5`, `3.0.4`, `3.0.3`, `3.0.2`, `3.0.1`, `3.0.0`
- `2.2.0`

</details>

**Latest Version**: `3.5.1`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +htop.dev@3.5.1 -- $SHELL -i
```

## Dependencies

This package depends on:

- `invisible-island.net/ncurses@6`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.htop

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/htop.dev/package.yml)
- [Homepage](https://htop.dev/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
