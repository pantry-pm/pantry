# fish

> User-friendly command-line shell for UNIX-like operating systems

## Package Information

- **Domain**: `fishshell.com`
- **Name**: `fish`
- **Homepage**: <https://fishshell.com>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/fishshell.com/package.yml)

## Installation

```bash
# Install with pantry
pantry install fishshell.com
```

## Programs

This package provides the following executable programs:

- `fish`
- `fish_indent`
- `fish_key_reader`

## Available Versions

<details>
<summary>Show all 47 versions</summary>

- `4.7.1`, `4.7.0`
- `4.6.0`
- `4.5.0`
- `4.4.0`
- `4.3.3`, `4.3.2`, `4.3.1`, `4.3.0`
- `4.2.1`, `4.2.0`
- `4.1.2`, `4.1.1`, `4.1.0`
- `4.0.9`, `4.0.8`, `4.0.6`, `4.0.2`, `4.0.1`, `4.0.0`
- `3.7.1`, `3.7.0`
- `3.6.4`, `3.6.3`, `3.6.2`, `3.6.1`, `3.6.0`
- `3.5.1`, `3.5.0`
- `3.4.1`, `3.4.0`
- `3.3.1`, `3.3.0`
- `3.2.2`, `3.2.1`, `3.2.0`
- `3.1.2`, `3.1.1`, `3.1.0`
- `3.0.2`, `3.0.1`, `3.0.0`
- `2.7.1`, `2.7.0`
- `2.6.0`
- `2.5.0`
- `2.4.0`

</details>

**Latest Version**: `4.7.1`

### Install Specific Version

```bash
# Install a specific version
pantry install fishshell.com@4.7.1
```

## Dependencies

This package depends on:

- `gnu.org/gettext`
- `invisible-island.net/ncurses>=6.0`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.fish

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/fishshell.com/package.yml)
- [Homepage](https://fishshell.com)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
