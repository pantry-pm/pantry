# robot

> Generic automation framework for acceptance testing and RPA

## Package Information

- **Domain**: `robotframework.org`
- **Name**: `robot`
- **Homepage**: <https://robotframework.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/robotframework.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install robotframework.org
```

## Programs

This package provides the following executable programs:

- `robot`

## Available Versions

<details>
<summary>Show all 22 versions</summary>

- `7.4.2`, `7.4.1`, `7.4`, `7.4.0`
- `7.3.2`, `7.3.1`, `7.3`, `7.3.0`
- `7.2.2`, `7.2.1`, `7.2`
- `7.1.1`, `7.1`
- `7.0.1`, `7.0`
- `6.1.1`, `6.1`
- `6.0.2`, `6.0.1`, `6.0`
- `5.0.1`, `5.0`

</details>

**Latest Version**: `7.4.2`

### Install Specific Version

```bash
# Install a specific version
pantry install robotframework.org@7.4.2
```

## Dependencies

This package depends on:

- `pkgx.sh>=1`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.robot

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/robotframework.org/package.yml)
- [Homepage](https://robotframework.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
