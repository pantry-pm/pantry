# speexdec

> Audio codec designed for speech

## Package Information

- **Domain**: `speex.org`
- **Name**: `speexdec`
- **Homepage**: <https://speex.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/speex.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install speex.org
```

## Programs

This package provides the following executable programs:

- `speexdec`

## Available Versions

<details>
<summary>Show all 1 versions</summary>

- `1.2.1`

</details>

**Latest Version**: `1.2.1`

### Install Specific Version

```bash
# Install a specific version
pantry install speex.org@1.2.1
```

## Dependencies

This package depends on:

- `xiph.org/ogg`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.speexdec

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/speex.org/package.yml)
- [Homepage](https://speex.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
