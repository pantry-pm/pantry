# rubygems

> Powerful, clean, object-oriented scripting language

## Package Information

- **Domain**: `rubygems.org`
- **Name**: `rubygems`
- **Homepage**: <https://www.ruby-lang.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/rubygems.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install rubygems.org
```

## Programs

This package provides the following executable programs:

- `bundle`
- `bundler`
- `gem`

## Available Versions

<details>
<summary>Show all 52 versions</summary>

- `4.0.14`, `4.0.13`, `4.0.12`, `4.0.11`, `4.0.10`, `4.0.9`, `4.0.8`, `4.0.7`, `4.0.6`, `4.0.5`, `4.0.4`, `4.0.3`, `4.0.2`, `4.0.1`, `4.0.0`
- `3.7.2`, `3.7.1`, `3.7.0`
- `3.6.9`, `3.6.8`, `3.6.7`, `3.6.6`, `3.6.5`, `3.6.4`, `3.6.3`, `3.6.2`, `3.6.1`, `3.6.0`
- `3.5.23`
- `bundler-v4.0.8`, `bundler-v4.0.7`, `bundler-v4.0.6`, `bundler-v4.0.5`, `bundler-v4.0.4`, `bundler-v4.0.3`, `bundler-v4.0.2`, `bundler-v4.0.1`, `bundler-v4.0.0`
- `bundler-v2.7.2`, `bundler-v2.7.1`, `bundler-v2.7.0`
- `bundler-v2.6.9`, `bundler-v2.6.8`, `bundler-v2.6.7`, `bundler-v2.6.6`, `bundler-v2.6.5`, `bundler-v2.6.4`, `bundler-v2.6.3`, `bundler-v2.6.2`, `bundler-v2.6.1`, `bundler-v2.6.0`
- `bundler-v2.5.23`

</details>

**Latest Version**: `4.0.14`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +rubygems.org@4.0.14 -- $SHELL -i
```

## Dependencies

This package depends on:

- `ruby-lang.org>=2.3`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.rubygems

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/rubygems.org/package.yml)
- [Homepage](https://www.ruby-lang.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
