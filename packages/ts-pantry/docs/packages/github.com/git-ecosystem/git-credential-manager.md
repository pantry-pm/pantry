# git-credential-manager

> Secure, cross-platform Git credential storage with authentication to GitHub, Azure Repos, and other popular Git hosting services.

## Package Information

- **Domain**: `github.com/git-ecosystem/git-credential-manager`
- **Name**: `git-credential-manager`
- **Homepage**: Not specified
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/github.com/git-ecosystem/git-credential-manager/package.yml)

## Installation

```bash
# Install with pantry
pantry install github.com/git-ecosystem/git-credential-manager
```

## Programs

This package provides the following executable programs:

- `git-credential-manager`

## Available Versions

<details>
<summary>Show all 39 versions</summary>

- `2.8.0`
- `2.7.3`, `2.7.2`, `2.7.1`, `2.7.0`
- `2.6.1`, `2.6.0`
- `2.5.1`, `2.5.0`
- `2.4.1`
- `2.3.2`, `2.3.1`, `2.3.0`
- `2.2.2`, `2.2.1`
- `2.1.2`
- `2.0.935`, `2.0.931`, `2.0.886`, `2.0.877`, `2.0.785`, `2.0.779`, `2.0.696`, `2.0.632`, `2.0.605`, `2.0.567`, `2.0.498`, `2.0.475`, `2.0.474`, `2.0.452`, `2.0.435-beta`, `2.0.394-beta`, `2.0.374-beta`, `2.0.318-beta`, `2.0.289-beta`, `2.0.280-beta`, `2.0.252-beta`, `2.0.194-beta`, `2.0.164-beta`

</details>

**Latest Version**: `2.8.0`

### Install Specific Version

```bash
# Install a specific version
pantry install github.com/git-ecosystem/git-credential-manager@2.8.0
```

## Dependencies

This package depends on:

- `openssl.org^1.1.1`
- `unicode.org^71`
- `zlib.net^1.3`
- `dotnet.microsoft.com^8.0`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry['git-credential-manager']

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/github.com/git-ecosystem/git-credential-manager/package.yml)
- [Homepage](#)
- [Back to Package Catalog](../../../package-catalog.md)

---

> Auto-generated from package data.
