# apptainer

> Application container and unprivileged sandbox platform for Linux

## Package Information

- **Domain**: `apptainer.org`
- **Name**: `apptainer`
- **Homepage**: <https://apptainer.org/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/apptainer.org/package.yml)

## Installation

```bash
# Install with pantry
pantry install apptainer.org
```

## Programs

This package provides the following executable programs:

- `apptainer`
- `run-singularity`
- `singularity`

## Available Versions

<details>
<summary>Show all 35 versions</summary>

- `1.5.1`, `1.5.0`
- `1.4.5`, `1.4.4`, `1.4.3`, `1.4.2`, `1.4.1`, `1.4.0`, `1.4.0-rc.2`
- `1.3.6`, `1.3.5`, `1.3.4`, `1.3.3`, `1.3.2`, `1.3.1`, `1.3.0`
- `1.2.5`, `1.2.4`, `1.2.3`, `1.2.2`, `1.2.1`, `1.2.0`
- `1.1.9`, `1.1.8`, `1.1.7`, `1.1.6`, `1.1.5`, `1.1.4`, `1.1.3`, `1.1.2`, `1.1.0`
- `1.0.3`, `1.0.2`, `1.0.1`, `1.0.0`

</details>

**Latest Version**: `1.5.1`

### Install Specific Version

```bash
# Install a specific version
pantry install apptainer.org@1.5.1
```

## Dependencies

This package depends on:

- `github.com/seccomp/libseccomp@2`
- `curl.se/ca-certs`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.apptainer

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/apptainer.org/package.yml)
- [Homepage](https://apptainer.org/)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
