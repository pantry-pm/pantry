# openslide

> C library to read whole-slide images (a.k.a. virtual slides)

## Package Information

- **Domain**: `openslide.org`
- **Name**: `openslide`
- **Homepage**: <https://openslide.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/openslide.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install openslide.org
```

## Programs

This package provides the following executable programs:

- `openslide-quickhash1sum`
- `openslide-show-properties`
- `openslide-write-png`

## Available Versions

<details>
<summary>Show all 30 versions</summary>

- `4.0.1`, `4.0.0`
- `3.4.1`, `3.4.0`
- `3.3.3`, `3.3.2`, `3.3.1`, `3.3.0`
- `3.2.6`, `3.2.5`, `3.2.4`, `3.2.3`, `3.2.2`, `3.2.1`, `3.2.0`
- `3.1.1`, `3.1.0`
- `3.0.3`, `3.0.2`, `3.0.1`, `3.0.0`
- `2.3.1`, `2.3.0`
- `2.2.1`, `2.2.0`
- `2.1.0`
- `2.0.0`
- `1.1.1`, `1.1.0`
- `1.0.0`

</details>

**Latest Version**: `4.0.1`

### Install Specific Version

```bash
# Install a specific version
pantry install openslide.org@4.0.1
```

## Dependencies

This package depends on:

- `cairographics.org`
- `gnome.org/gdk-pixbuf`
- `gnome.org/glib`
- `libjpeg-turbo.org`
- `libpng.org`
- `simplesystems.org/libtiff`
- `gnome.org/libxml2`
- `openjpeg.org`
- `sqlite.org`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.openslide

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/openslide.org/package.yml)
- [Homepage](https://openslide.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
