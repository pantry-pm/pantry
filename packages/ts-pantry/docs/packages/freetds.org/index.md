# freetds

> Libraries to talk to Microsoft SQL Server and Sybase databases

## Package Information

- **Domain**: `freetds.org`
- **Name**: `freetds`
- **Homepage**: <https://www.freetds.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/freetds.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install freetds.org
```

## Programs

This package provides the following executable programs:

- `bsqldb`
- `bsqlodbc`
- `datacopy`
- `defncopy`
- `fisql`
- `freebcp`
- `osql`
- `tdspool`
- `tsql`

## Available Versions

<details>
<summary>Show all 25 versions</summary>

- `1.5.16`, `1.5.15`, `1.5.14`, `1.5.13`, `1.5.12`, `1.5.11`, `1.5.10`, `1.5.9`, `1.5.8`, `1.5.7`, `1.5.6`, `1.5.5`, `1.5.4`, `1.5.3`, `1.5.2`, `1.5.1`, `1.5`
- `1.4.27`, `1.4.26`, `1.4.24`, `1.4.23`, `1.4.22`, `1.4.12`, `1.4.11`, `1.4.10`

</details>

**Latest Version**: `1.5.16`

### Install Specific Version

```bash
# Install a specific version
pantry install freetds.org@1.5.16
```

## Dependencies

This package depends on:

- `openssl.org^1.1`
- `unixodbc.org`
- `kerberos.org`
- `gnu.org/readline`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.freetds

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/freetds.org/package.yml)
- [Homepage](https://www.freetds.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
