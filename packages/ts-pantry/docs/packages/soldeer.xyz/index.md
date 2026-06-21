# soldeer

> Solidity Package Manager written in rust and integrated into Foundry (forge soldeer ...)

## Package Information

- **Domain**: `soldeer.xyz`
- **Name**: `soldeer`
- **Homepage**: <https://soldeer.xyz>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/soldeer.xyz/package.yml)

## Installation

```bash
# Install with pantry
pantry install soldeer.xyz
```

## Programs

This package provides the following executable programs:

- `soldeer`

## Available Versions

<details>
<summary>Show all 46 versions</summary>

- `0.11.0`
- `0.10.1`, `0.10.0`
- `0.9.0`
- `0.8.0`
- `0.7.1`, `0.7.0`
- `0.6.1`, `0.6.0`
- `0.5.4`, `0.5.3`, `0.5.2`, `0.5.1`, `0.5.0`
- `0.4.1`, `0.4.0`
- `0.3.4`, `0.3.3`, `0.3.2`, `0.3.1`, `0.3.0`
- `0.2.19`, `0.2.18`, `0.2.17`, `0.2.16`, `0.2.15`, `0.2.14`, `0.2.13`, `0.2.12`, `0.2.11`, `0.2.10`, `0.2.9`, `0.2.8`, `0.2.7`, `0.2.6`, `0.2.5`, `0.2.4`, `0.2.3`, `0.2.2`, `0.2.1`, `0.2.0`
- `0.1.5`, `0.1.4`, `0.1.3`, `0.1.2`, `0.1.1`

</details>

**Latest Version**: `0.11.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +soldeer.xyz@0.11.0 -- $SHELL -i
```

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.soldeer

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/soldeer.xyz/package.yml)
- [Homepage](https://soldeer.xyz)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
