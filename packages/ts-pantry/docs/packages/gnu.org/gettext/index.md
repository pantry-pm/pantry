# gettext

> GNU internationalization (i18n) and localization (l10n) library

## Package Information

- **Domain**: `gnu.org/gettext`
- **Name**: `gettext`
- **Homepage**: <https://www.gnu.org/software/gettext/>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/gnu.org/gettext/package.yml)

## Installation

```bash
# Install with pantry
pantry install gnu.org/gettext
```

## Programs

This package provides the following executable programs:

- `autopoint`
- `envsubst`
- `gettext`
- `gettext.sh`
- `gettextize`
- `msgattrib`
- `msgcat`
- `msgcmp`
- `msgcomm`
- `msgconv`
- `msgen`
- `msgexec`
- `msgfilter`
- `msgfmt`
- `msggrep`
- `msginit`
- `msgmerge`
- `msgunfmt`
- `msguniq`
- `ngettext`
- `recode-sr-latin`
- `xgettext`

## Available Versions

<details>
<summary>Show all 51 versions</summary>

- `1.0.0`
- `0.26`
- `0.25.1`, `0.25`
- `0.24.2`, `0.24.1`, `0.24`
- `0.23.2`, `0.23.1`, `0.23`
- `0.22.5`, `0.22.4`, `0.22.3`, `0.22.2`, `0.22.1`, `0.22`, `0.22.0`
- `0.21.1`, `0.21`
- `0.20.2`, `0.20.1`, `0.20`
- `0.19.8.1`, `0.19.8`, `0.19.7`, `0.19.6`, `0.19.5.1`, `0.19.5`, `0.19.4`, `0.19.3`, `0.19.2.1`, `0.19.2`, `0.19.1`, `0.19`
- `0.18.3.2`, `0.18.3.1`, `0.18.3`, `0.18.2.1`, `0.18.2`, `0.18.1.1`, `0.18.1`, `0.18`
- `0.17`
- `0.16.1`, `0.16`
- `0.15`
- `0.14.6`, `0.14.5`, `0.14.4`, `0.14.3`, `0.14.2`

</details>

**Latest Version**: `1.0.0`

### Install Specific Version

```bash
# Install a specific version
pantry install gnu.org/gettext@1.0.0
```

## Dependencies

This package depends on:

- `gnome.org/libxml2~2.13 # 2.14 changes the API`
- `tukaani.org/xz^5 # autopoint needs this to unpack archives`

## Usage Examples

```typescript
import { pantry } from 'ts-pantry'

// Access this package
const pkg = pantry.gettext

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/gnu.org/gettext/package.yml)
- [Homepage](https://www.gnu.org/software/gettext/)
- [Back to Package Catalog](../../../package-catalog.md)

---

> Auto-generated from package data.
