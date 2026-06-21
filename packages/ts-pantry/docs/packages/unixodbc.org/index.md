# unixodbc

> The unixODBC Project goals are to develop and promote unixODBC to be the definitive standard for ODBC on non MS Windows platforms.

## Package Information

- **Domain**: `unixodbc.org`
- **Name**: `unixodbc`
- **Homepage**: <https://www.unixodbc.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/unixodbc.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install unixodbc.org
```

## Programs

This package provides the following executable programs:

- `dltest`
- `isql`
- `iusql`
- `odbc_config`
- `odbcinst`
- `slencheck`

## Available Versions

<details>
<summary>Show all 4 versions</summary>

- `2.3.14`, `2.3.13`, `2.3.12`, `2.3.11`

</details>

**Latest Version**: `2.3.14`

### Install Specific Version

```bash
# Install a specific version
pantry install unixodbc.org@2.3.14
```

## Dependencies

This package depends on:

- `gnu.org/libtool`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.unixodbc

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/unixodbc.org/package.yml)
- [Homepage](https://www.unixodbc.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
