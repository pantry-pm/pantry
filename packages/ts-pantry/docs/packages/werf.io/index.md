# werf

> A solution for implementing efficient and consistent software delivery to Kubernetes facilitating best practices.

## Package Information

- **Domain**: `werf.io`
- **Name**: `werf`
- **Homepage**: <https://werf.io/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/werf.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install werf.io
```

## Programs

This package provides the following executable programs:

- `werf`

## Available Versions

<details>
<summary>Show all 65 versions</summary>

- `2.72.0`
- `2.70.0`
- `2.69.1`, `2.69.0`
- `2.68.2`, `2.68.1`, `2.68.0`
- `2.67.2`, `2.67.1`, `2.67.0`
- `2.66.2`, `2.66.1`, `2.66.0`
- `2.65.4`, `2.65.3`, `2.65.2`, `2.65.1`, `2.65.0`
- `2.64.0`
- `2.63.1`, `2.63.0`
- `2.62.2`, `2.62.1`
- `2.61.1`, `2.61.0`
- `2.60.0`
- `2.59.0`
- `2.58.0`
- `2.57.2`, `2.57.1`, `2.57.0`
- `2.56.2`, `2.56.1`, `2.56.0`
- `2.55.6`, `2.55.4`, `2.55.3`, `2.55.2`, `2.55.1`, `2.55.0`
- `2.54.1`, `2.54.0`
- `2.53.5`, `2.53.4`, `2.53.3`, `2.53.2`, `2.53.1`, `2.53.0`
- `2.52.0`
- `2.51.7`, `2.51.6`, `2.51.5`, `2.51.4`, `2.51.3`, `2.51.2`, `2.51.1`, `2.51.0`
- `2.50.2`, `2.50.1`
- `2.49.4`, `2.49.1`, `2.49.0`
- `2.48.3`
- `1.2.336`, `1.2.335`

</details>

**Latest Version**: `2.72.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +werf.io@2.72.0 -- $SHELL -i
```

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.werf

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/werf.io/package.yml)
- [Homepage](https://werf.io/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
