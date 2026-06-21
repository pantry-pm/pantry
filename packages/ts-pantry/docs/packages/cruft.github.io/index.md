# cruft

> Allows you to maintain all the necessary cruft for packaging and building projects separate from the code you intentionally write. Built on-top of, and fully compatible with, CookieCutter.

## Package Information

- **Domain**: `cruft.github.io`
- **Name**: `cruft`
- **Homepage**: <https://cruft.github.io/cruft/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/cruft.github.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install cruft.github.io
```

## Programs

This package provides the following executable programs:

- `cruft`

## Available Versions

<details>
<summary>Show all 20 versions</summary>

- `2.16.0`
- `2.15.0`
- `2.14.0`
- `2.13.0`
- `2.12.0`
- `2.11.1`, `2.11.0`
- `2.10.2`, `2.10.1`, `2.10.0`
- `2.9.0`
- `2.8.0`
- `2.7.0`
- `2.6.0`
- `2.5.0`
- `2.4.0`
- `2.3.0`
- `2.2.0`
- `2.1.0`
- `2.0.0`

</details>

**Latest Version**: `2.16.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +cruft.github.io@2.16.0 -- $SHELL -i
```

## Dependencies

This package depends on:

- `python.org>=3.7<3.12`
- `git-scm.org^2`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.cruft

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/cruft.github.io/package.yml)
- [Homepage](https://cruft.github.io/cruft/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
