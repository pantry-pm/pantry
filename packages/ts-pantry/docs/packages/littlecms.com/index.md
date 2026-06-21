# littlecms

> A free, open source, CMM engine. It provides fast transforms between ICC profiles.

## Package Information

- **Domain**: `littlecms.com`
- **Name**: `littlecms`
- **Homepage**: <https://www.littlecms.com/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/littlecms.com/package.yml)

## Installation

```bash
# Install with pantry
pantry install littlecms.com
```

## Programs

This package provides the following executable programs:

- `jpgicc`
- `linkicc`
- `psicc`
- `tificc`
- `transicc`

## Available Versions

<details>
<summary>Show all 16 versions</summary>

- `2.19.1`, `2.19`
- `2.18`, `2.18.0`
- `2.17`, `2.17.0`
- `2.16`, `2.16.0`
- `2.15`, `2.15.0`
- `2.14`
- `2.13.1`, `2.13`
- `2.12`, `2.12.0`
- `2.10`

</details>

**Latest Version**: `2.19.1`

### Install Specific Version

```bash
# Install a specific version
pantry install littlecms.com@2.19.1
```

## Dependencies

This package depends on:

- `simplesystems.org/libtiff^4`
- `libjpeg-turbo.org^2`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.littlecms

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/littlecms.com/package.yml)
- [Homepage](https://www.littlecms.com/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
