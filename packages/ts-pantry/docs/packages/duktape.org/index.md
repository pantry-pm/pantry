# duk

> Duktape - embeddable Javascript engine with a focus on portability and compact footprint

## Package Information

- **Domain**: `duktape.org`
- **Name**: `duk`
- **Homepage**: <https://duktape.org>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/duktape.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install duktape.org
```

## Programs

This package provides the following executable programs:

- `duk`

## Available Versions

<details>
<summary>Show all 42 versions</summary>

- `2.7.0`
- `2.6.0`
- `2.5.0`
- `2.4.0`
- `2.3.0`
- `2.2.1`, `2.2.0`
- `2.1.2`, `2.1.1`, `2.1.0`
- `2.0.3`, `2.0.2`, `2.0.1`, `2.0.0`
- `1.8.0`
- `1.7.0`
- `1.6.1`, `1.6.0`
- `1.5.2`, `1.5.1`, `1.5.0`
- `1.4.2`, `1.4.1`, `1.4.0`
- `1.3.3`, `1.3.2`, `1.3.1`, `1.3.0`
- `1.2.6`, `1.2.5`, `1.2.4`, `1.2.3`, `1.2.2`, `1.2.1`, `1.2.0`
- `1.1.3`, `1.1.2`, `1.1.1`, `1.1.0`
- `1.0.2`, `1.0.1`, `1.0.0`

</details>

**Latest Version**: `2.7.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +duktape.org@2.7.0 -- $SHELL -i
```

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.duk

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/duktape.org/package.yml)
- [Homepage](https://duktape.org)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
