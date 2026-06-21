# terraform

> Terraform enables you to safely and predictably create, change, and improve infrastructure. It is a source-available tool that codifies APIs into declarative configuration files that can be shared amongst team members, treated as code, edited, reviewed, and versioned.

## Package Information

- **Domain**: `terraform.io`
- **Name**: `terraform`
- **Homepage**: <https://www.terraform.io>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/terraform.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install terraform.io
```

## Programs

This package provides the following executable programs:

- `terraform`

## Available Versions

<details>
<summary>Show all 29 versions</summary>

- `1.15.6`, `1.15.5`, `1.15.4`, `1.15.3`, `1.15.2`, `1.15.1`, `1.15.0`
- `1.14.9`, `1.14.8`, `1.14.7`, `1.14.6`, `1.14.5`, `1.14.4`, `1.14.3`, `1.14.2`, `1.14.1`, `1.14.0`
- `1.13.5`, `1.13.4`, `1.13.3`, `1.13.2`, `1.13.1`, `1.13.0`
- `1.12.2`, `1.12.1`, `1.12.0`
- `1.11.4`, `1.11.3`, `1.11.2`

</details>

**Latest Version**: `1.15.6`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +terraform.io@1.15.6 -- $SHELL -i
```

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.terraform

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/terraform.io/package.yml)
- [Homepage](https://www.terraform.io)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
