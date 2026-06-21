# terratag

> Terratag is a CLI tool that enables users of Terraform to automatically create and maintain tags across their entire set of AWS, Azure, and GCP resources

## Package Information

- **Domain**: `terratag.io`
- **Name**: `terratag`
- **Homepage**: <https://terratag.io>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/terratag.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install terratag.io
```

## Programs

This package provides the following executable programs:

- `terratag`

## Available Versions

<details>
<summary>Show all 50 versions</summary>

- `0.7.6`, `0.7.5`, `0.7.4`, `0.7.3`, `0.7.2`, `0.7.1`, `0.7.0`
- `0.6.1`, `0.6.0`
- `0.5.3`, `0.5.2`, `0.5.1`, `0.5.0`
- `0.4.1`, `0.4.0`
- `0.3.5`, `0.3.4`, `0.3.3`, `0.3.2`, `0.3.1`, `0.3.0`
- `0.2.6`, `0.2.5`, `0.2.4`, `0.2.3`, `0.2.2`, `0.2.1`, `0.2.0`
- `0.1.50`, `0.1.49`, `0.1.48`, `0.1.47`, `0.1.46`, `0.1.45`, `0.1.44`, `0.1.43`, `0.1.42`, `0.1.41`, `0.1.40`, `0.1.37`, `0.1.36`, `0.1.35`, `0.1.34`, `0.1.33`, `0.1.32`, `0.1.31`, `0.1.30`, `0.1.29`, `0.1.28`, `0.1.27`

</details>

**Latest Version**: `0.7.6`

### Install Specific Version

```bash
# Install a specific version
pantry install terratag.io@0.7.6
```

## Dependencies

This package depends on:

- `terraform.io>=0.12`
- `curl.se/ca-certs`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.terratag

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/terratag.io/package.yml)
- [Homepage](https://terratag.io)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
