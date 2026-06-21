# lunarvim

> 🌙 LunarVim is an IDE layer for Neovim. Completely free and community driven.

## Package Information

- **Domain**: `lunarvim.org`
- **Name**: `lunarvim`
- **Homepage**: <https://www.lunarvim.org>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/lunarvim.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install lunarvim.org
```

## Programs

This package provides the following executable programs:

- `lvim`
- `nvim`

## Available Versions

<details>
<summary>Show all 26 versions</summary>

- `1.4.0`
- `1.3.0`
- `1.2.0`
- `1.1.4`, `1.1.3`, `1.1.2`, `1.1.1`, `1.1.0`
- `1.0.0`
- `0.6.1`, `0.6.0`
- `0.5.1`, `0.5.0`
- `0.4.8`, `0.4.7`, `0.4.6`, `0.4.5`, `0.4.4`, `0.4.3`, `0.4.2`, `0.4.1`, `0.4.0`
- `0.3.1`, `0.3.0`
- `0.2.0`
- `0.1.0`

</details>

**Latest Version**: `1.4.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +lunarvim.org@1.4.0 -- $SHELL -i
```

## Dependencies

This package depends on:

- `gnu.org/bash`
- `crates.io/fd-find`
- `pip.pypa.io`
- `python.org^3`
- `nodejs.org`
- `rust-lang.org/cargo`
- `neovim.io`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.lunarvim

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/lunarvim.org/package.yml)
- [Homepage](https://www.lunarvim.org)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
