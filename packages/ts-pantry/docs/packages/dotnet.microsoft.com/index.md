# dotnet

> Home of the .NET platform

## Package Information

- **Domain**: `dotnet.microsoft.com`
- **Name**: `dotnet`
- **Homepage**: <https://dotnet.microsoft.com/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/dotnet.microsoft.com/package.yml)

## Installation

```bash
# Install with pantry
pantry install dotnet.microsoft.com
```

## Programs

This package provides the following executable programs:

- `dotnet`

## Available Versions

<details>
<summary>Show all 90 versions</summary>

- `10.0.301`, `10.0.300`, `10.0.204`, `10.0.203`, `10.0.201`, `10.0.200`, `10.0.109`, `10.0.108`, `10.0.107`, `10.0.105`, `10.0.104`, `10.0.103`, `10.0.102`, `10.0.101`, `10.0.100`, `10.0.5`, `10.0.4`
- `9.0.314`, `9.0.313`, `9.0.311`, `9.0.310`, `9.0.309`, `9.0.308`, `9.0.307`, `9.0.306`, `9.0.305`, `9.0.304`, `9.0.303`, `9.0.302`, `9.0.301`, `9.0.300`, `9.0.205`, `9.0.204`, `9.0.203`, `9.0.202`, `9.0.201`, `9.0.200`, `9.0.114`, `9.0.113`, `9.0.111`, `9.0.102`, `9.0.100`
- `8.0.421`, `8.0.418`, `8.0.417`, `8.0.416`, `8.0.415`, `8.0.414`, `8.0.411`, `8.0.410`, `8.0.409`, `8.0.408`, `8.0.407`, `8.0.406`, `8.0.405`, `8.0.404`, `8.0.403`, `8.0.402`, `8.0.401`, `8.0.400`, `8.0.318`, `8.0.313`, `8.0.308`, `8.0.303`, `8.0.302`, `8.0.301`, `8.0.206`, `8.0.204`, `8.0.203`, `8.0.124`, `8.0.121`, `8.0.112`, `8.0.107`, `8.0.106`, `8.0.104`, `8.0.101`, `8.0.100`
- `7.0.404`, `7.0.306`, `7.0.120`
- `6.0.428`, `6.0.427`, `6.0.425`, `6.0.424`, `6.0.423`, `6.0.422`, `6.0.417`, `6.0.132`, `6.0.131`, `6.0.130`

</details>

**Latest Version**: `10.0.301`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +dotnet.microsoft.com@10.0.301 -- $SHELL -i
```

## Dependencies

This package depends on:

- `linux:unicode.org^71`
- `linux:openssl.org`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.dotnet

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/dotnet.microsoft.com/package.yml)
- [Homepage](https://dotnet.microsoft.com/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
