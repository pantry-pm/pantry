# classic.yarnpkg

> The 1.x line is frozen - features and bugfixes now happen on <https://github.com/yarnpkg/berry>

## Package Information

- **Domain**: `classic.yarnpkg.com`
- **Name**: `classic.yarnpkg`
- **Homepage**: <https://yarnpkg.com/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/classic.yarnpkg.com/package.yml)

## Installation

```bash
# Install with pantry
pantry install yarn
```

## Programs

This package provides the following executable programs:

- `yarn`
- `yarnpkg`

## Aliases

This package can also be accessed using these aliases:

- `yarn`

## Available Versions

<details>
<summary>Show all 37 versions</summary>

- `1.22.22`, `1.22.21`, `1.22.20`, `1.22.19`, `1.22.18`, `1.22.17`, `1.22.16`, `1.22.15`, `1.22.14`, `1.22.13`, `1.22.12`, `1.22.11`, `1.22.10`, `1.22.5`, `1.22.4`, `1.22.3`, `1.22.2`, `1.22.1`, `1.22.0`
- `1.21.1`, `1.21.0`
- `1.19.2`, `1.19.1`, `1.19.0`
- `1.18.0`
- `1.17.3`
- `1.16.0`
- `1.15.2`
- `1.14.0`
- `1.13.0`
- `1.12.3`, `1.12.1`
- `1.10.1`, `1.10.0`
- `1.9.4`, `1.9.3`, `1.9.2`

</details>

**Latest Version**: `1.22.22`

### Install Specific Version

```bash
# Install a specific version
pantry install classic.yarnpkg.com@1.22.22
```

## Dependencies

This package depends on:

- `nodejs.org>=5`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.yarn

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/classic.yarnpkg.com/package.yml)
- [Homepage](https://yarnpkg.com/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
