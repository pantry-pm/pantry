# pod

> Dependency manager for Cocoa projects

## Package Information

- **Domain**: `cocoapods.org`
- **Name**: `pod`
- **Homepage**: <https://cocoapods.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/cocoapods.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install cocoapods.org
```

## Programs

This package provides the following executable programs:

- `pod`

## Available Versions

<details>
<summary>Show all 35 versions</summary>

- `1.16.2`, `1.16.1`, `1.16.0`
- `1.15.2`, `1.15.1`, `1.15.0`
- `1.14.3`, `1.14.2`, `1.14.1`, `1.14.0`
- `1.13.0`
- `1.12.1`, `1.12.0`
- `1.11.3`, `1.11.2`, `1.11.1`, `1.11.0`
- `1.10.2`, `1.10.1`, `1.10.0`
- `1.9.3`, `1.9.2`, `1.9.1`, `1.9.0`
- `1.8.4`, `1.8.3`, `1.8.1`, `1.8.0`
- `1.7.5`, `1.7.4`, `1.7.3`, `1.7.2`, `1.7.1`, `1.7.0`
- `1.6.2`

</details>

**Latest Version**: `1.16.2`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +cocoapods.org@1.16.2 -- $SHELL -i
```

## Dependencies

This package depends on:

- `ruby-lang.org~3.2`
- `sourceware.org/libffi^3`
- `rubygems.org^3`
- `git-scm.org^2`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.pod

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/cocoapods.org/package.yml)
- [Homepage](https://cocoapods.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
