# macvim

> Vim - the text editor - for macOS

## Package Information

- **Domain**: `macvim.org`
- **Name**: `macvim`
- **Homepage**: <https://macvim.org>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/macvim.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install macvim.org
```

## Programs

This package provides the following executable programs:

- `gview`
- `gvim`
- `gvimdiff`
- `gvimtutor`
- `mview`
- `mvim`
- `mvimdiff`
- `mvimtutor`
- `view`
- `vim`
- `vimdiff`
- `vimtutor`

## Available Versions

<details>
<summary>Show all 15 versions</summary>

- `183`
- `182`
- `182.0.0`
- `181`
- `181.0.0`
- `180`
- `180.0.0`
- `179`
- `179.0.0`
- `178`
- `178.0.0`
- `177`
- `177.0.0`
- `176`
- `174`

</details>

**Latest Version**: `183`

### Install Specific Version

```bash
# Install a specific version
pantry install macvim.org@183
```

## Dependencies

This package depends on:

- `cscope.sourceforge.io`
- `invisible-island.net/ncurses`
- `lua.org`
- `python.org~3.11`
- `ruby-lang.org`
- `libsodium.org`
- `gnu.org/gettext`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.macvim

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/macvim.org/package.yml)
- [Homepage](https://macvim.org)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
