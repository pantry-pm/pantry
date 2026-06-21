# hunspell

> Spell checker and morphological analyzer

## Package Information

- **Domain**: `hunspell.github.io`
- **Name**: `hunspell`
- **Homepage**: <https://hunspell.github.io>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/hunspell.github.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install hunspell.github.io
```

## Programs

This package provides the following executable programs:

- `analyze`
- `chmorph`
- `hunspell`
- `hunzip`
- `hzip`
- `munch`
- `unmunch`

## Available Versions

<details>
<summary>Show all 14 versions</summary>

- `1.7.3`, `1.7.2`, `1.7.1`, `1.7.0`
- `1.6.2`, `1.6.1`, `1.6.0`
- `1.5.4`, `1.5.3`, `1.5.2`, `1.5.1`
- `1.4.1`, `1.4.0`
- `1.3.4`

</details>

**Latest Version**: `1.7.3`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +hunspell.github.io@1.7.3 -- $SHELL -i
```

## Dependencies

This package depends on:

- `gnu.org/readline`
- `invisible-island.net/ncurses`
- `gnu.org/gettext`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.hunspell

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/hunspell.github.io/package.yml)
- [Homepage](https://hunspell.github.io)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
