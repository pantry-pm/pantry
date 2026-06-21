# mas

> :package: Mac App Store command line interface

## Package Information

- **Domain**: `github.com/mas-cli/mas`
- **Name**: `mas`
- **Homepage**: Not specified
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/github.com/mas-cli/mas/package.yml)

## Installation

```bash
# Install with pantry
pantry install github.com/mas-cli/mas
```

## Programs

This package provides the following executable programs:

- `mas`

## Available Versions

<details>
<summary>Show all 50 versions</summary>

- `7.0.0`
- `6.0.1`, `6.0.0`
- `5.2.0`
- `5.1.0`
- `5.0.2`, `5.0.1`, `5.0.0`
- `4.1.2`, `4.1.1`, `4.1.0`
- `4.0.0`
- `3.1.0`
- `3.0.1`, `3.0.0`
- `2.3.0`
- `2.2.2`, `2.2.1`, `2.2.0`
- `2.1.0`
- `2.0.0`
- `1.9.0`
- `1.8.8`, `1.8.7`, `1.8.6`, `1.8.5`, `1.8.4`, `1.8.3`, `1.8.2`, `1.8.1`, `1.8.0`
- `1.7.1`, `1.7.0`
- `1.6.4`, `1.6.3`, `1.6.2`, `1.6.1`, `1.6.0`
- `1.5.0`
- `1.4.4`, `1.4.3`, `1.4.2`, `1.4.1`, `1.4.0`
- `1.3.1`, `1.3.0`
- `1.2.2`, `1.2.1`, `1.2.0`
- `1.1.3`

</details>

**Latest Version**: `7.0.0`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +github.com/mas-cli/mas@7.0.0 -- $SHELL -i
```

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.mas

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/github.com/mas-cli/mas/package.yml)
- [Homepage](#)
- [Back to Package Catalog](../../../package-catalog.md)

---

> Auto-generated from package data.
