# terragrunt

> Terragrunt is a flexible orchestration tool that allows Infrastructure as Code written in OpenTofu/Terraform to scale.

## Package Information

- **Domain**: `terragrunt.gruntwork.io`
- **Name**: `terragrunt`
- **Homepage**: <https://terragrunt.gruntwork.io/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/terragrunt.gruntwork.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install terragrunt.gruntwork.io
```

## Programs

This package provides the following executable programs:

- `terragrunt`

## Available Versions

<details>
<summary>Show all 32 versions</summary>

- `1.0.8`, `1.0.7`, `1.0.6`, `1.0.5`, `1.0.4`, `1.0.3`, `1.0.2`, `1.0.1`, `1.0.0`
- `0.99.5`, `0.99.4`, `0.99.3`, `0.99.2`, `0.99.1`, `0.99.0`
- `0.98.0`
- `0.97.2`, `0.97.1`, `0.97.0`
- `0.96.1`, `0.96.0`
- `0.95.1`, `0.95.0`
- `0.94.0`
- `0.93.13`, `0.93.12`, `0.93.11`, `0.93.10`, `0.93.9`, `0.93.8`, `0.93.7`, `0.93.6`

</details>

**Latest Version**: `1.0.8`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +terragrunt.gruntwork.io@1.0.8 -- $SHELL -i
```

## Dependencies

This package depends on:

- `terraform.io`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.terragrunt

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/terragrunt.gruntwork.io/package.yml)
- [Homepage](https://terragrunt.gruntwork.io/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
