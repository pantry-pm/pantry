# sqlite3

> Official Git mirror of the SQLite source tree

## Package Information

- **Domain**: `sqlite.org`
- **Name**: `sqlite3`
- **Homepage**: <https://sqlite.org/index.html>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/sqlite.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install sqlite
```

## Programs

This package provides the following executable programs:

- `sqlite3`

## Aliases

This package can also be accessed using these aliases:

- `sqlite`

## Available Versions

<details>
<summary>Show all 50 versions</summary>

- `3.53.2`, `3.53.1`, `3.53.0`
- `3.52.0`
- `3.51.3`, `3.51.2`, `3.51.1`, `3.51.0`
- `3.50.4`, `3.50.3`, `3.50.2`, `3.50.1`, `3.50.0`
- `3.49.2`, `3.49.1`, `3.49.0`
- `3.48.0`
- `3.47.2`, `3.47.1`, `3.47.0`
- `3.46.1`, `3.46.0`
- `3.45.3`, `3.45.2`, `3.45.1`, `3.45.0`
- `3.44.5`, `3.44.4`, `3.44.3`, `3.44.2`, `3.44.1`, `3.44.0`
- `3.43.2`, `3.43.1`, `3.43.0`
- `3.42.1`, `3.42.0`
- `3.41.2`, `3.41.1`, `3.41.0`
- `3.40.1`, `3.40.0`
- `3.39.4`, `3.39.3`, `3.39.2`, `3.39.1`, `3.39.0`
- `3.38.5`, `3.38.4`, `3.38.3`

</details>

**Latest Version**: `3.53.2`

### Install Specific Version

```bash
# Install a specific version
pantry install sqlite.org@3.53.2
```

## Dependencies

This package depends on:

- `zlib.net@1`
- `gnu.org/readline@8`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.sqlite

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/sqlite.org/package.yml)
- [Homepage](https://sqlite.org/index.html)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
