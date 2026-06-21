# git2

> A cross-platform, linkable library implementation of Git that you can use in your application.

## Package Information

- **Domain**: `libgit2.org`
- **Name**: `git2`
- **Homepage**: <https://libgit2.github.com/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/libgit2.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install libgit2.org
```

## Programs

This package provides the following executable programs:

- `git2`

## Available Versions

<details>
<summary>Show all 50 versions</summary>

- `1.9.4`, `1.9.3`, `1.9.2`, `1.9.1`, `1.9.0`
- `1.8.5`, `1.8.4`, `1.8.3`, `1.8.2`, `1.8.1`, `1.8.0`
- `1.7.2`, `1.7.1`, `1.7.0`
- `1.6.5`, `1.6.4`, `1.6.3`, `1.6.2`, `1.6.1`
- `1.5.2`, `1.5.1`, `1.5.0`
- `1.4.6`, `1.4.5`, `1.4.4`, `1.4.3`, `1.4.2`, `1.4.1`, `1.4.0`
- `1.3.2`, `1.3.1`, `1.3.0`
- `1.2.0`
- `1.1.1`, `1.1.0`
- `1.0.1`, `1.0.0`
- `0.99.0`
- `0.28.5`, `0.28.4`, `0.28.3`, `0.28.2`, `0.28.1`, `0.28.0`
- `0.27.10`, `0.27.9`, `0.27.8`, `0.27.7`, `0.27.6`
- `0.26.8`

</details>

**Latest Version**: `1.9.4`

### Install Specific Version

```bash
# Install a specific version
pantry install libgit2.org@1.9.4
```

## Dependencies

This package depends on:

- `libssh2.org^1`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.git2

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/libgit2.org/package.yml)
- [Homepage](https://libgit2.github.com/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
