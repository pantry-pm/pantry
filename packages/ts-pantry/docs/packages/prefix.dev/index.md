# pixi

> Package management made easy

## Package Information

- **Domain**: `prefix.dev`
- **Name**: `pixi`
- **Homepage**: <https://pixi.sh>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/prefix.dev/package.yml)

## Installation

```bash
# Install with pantry
pantry install prefix.dev
```

## Programs

This package provides the following executable programs:

- `pixi`

## Available Versions

<details>
<summary>Show all 59 versions</summary>

- `0.70.2`, `0.70.1`, `0.70.0`
- `0.69.0`
- `0.68.1`, `0.68.0`
- `0.67.2`, `0.67.1`, `0.67.0`
- `0.66.0`
- `0.65.0`
- `0.64.0`
- `0.63.2`, `0.63.1`, `0.63.0`
- `0.62.2`, `0.62.1`, `0.62.0`
- `0.61.0`
- `0.60.0`
- `0.59.0`
- `0.58.0`
- `0.57.0`
- `0.56.0`
- `0.55.0`
- `0.54.2`, `0.54.1`, `0.54.0`
- `0.53.0`
- `0.52.0`
- `0.51.0`
- `0.50.2`, `0.50.1`, `0.50.0`
- `0.49.0`
- `0.48.2`, `0.48.1`, `0.48.0`
- `0.47.0`
- `0.46.0`
- `0.45.0`
- `0.44.0`
- `0.43.3`, `0.43.2`, `0.43.1`, `0.43.0`
- `0.42.1`, `0.42.0`
- `0.41.4`, `0.41.3`, `0.41.2`, `0.41.1`, `0.41.0`
- `0.40.3`, `0.40.2`, `0.40.1`, `0.40.0`
- `0.39.5`, `0.39.4`

</details>

**Latest Version**: `0.70.2`

### Install Specific Version

```bash
# Install a specific version
pantry install prefix.dev@0.70.2
```

## Dependencies

This package depends on:

- `openssl.org^1.1`
- `libgit2.org~1.7 # links to libgit2.so.1.7`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.pixi

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/prefix.dev/package.yml)
- [Homepage](https://pixi.sh)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
