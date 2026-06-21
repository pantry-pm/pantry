# systemd

> The systemd System and Service Manager

## Package Information

- **Domain**: `systemd.io`
- **Name**: `systemd`
- **Homepage**: <https://systemd.io>
- **Source**: [View on GitHub](https://github.com/pkgxdev/pantry/tree/main/projects/systemd.io/package.yml)

## Installation

```bash
# Install with pantry
pantry install systemd.io
```

## Programs

This package provides the following executable programs:

- `busctl`
- `coredumpctl`
- `hostnamectl`
- `journalctl`
- `kernel-install`
- `localectl`
- `loginctl`
- `machinectl`
- `networkctl`
- `oomctl`
- `portablectl`
- `resolvectl`
- `systemctl`
- `systemd-ac-power`
- `systemd-analyze`
- `systemd-ask-password`
- `systemd-cat`
- `systemd-cgls`
- `systemd-cgtop`
- `systemd-confext`
- `systemd-creds`
- `systemd-delta`
- `systemd-detect-virt`
- `systemd-dissect`
- `systemd-escape`
- `systemd-firstboot`
- `systemd-id128`
- `systemd-inhibit`
- `systemd-machine-id-setup`
- `systemd-mount`
- `systemd-notify`
- `systemd-nspawn`
- `systemd-path`
- `systemd-repart`
- `systemd-resolve`
- `systemd-run`
- `systemd-socket-activate`
- `systemd-stdio-bridge`
- `systemd-sysext`
- `systemd-sysusers`
- `systemd-tmpfiles`
- `systemd-tty-ask-password-agent`
- `systemd-umount`
- `timedatectl`
- `udevadm`
- `userdbctl`
- `halt`
- `init`
- `mount.ddi`
- `poweroff`
- `reboot`
- `resolvconf`
- `runlevel`
- `shutdown`
- `telinit`

## Available Versions

<details>
<summary>Show all 45 versions</summary>

- `261`
- `260.2`
- `260.1`
- `260`
- `259.6`
- `259.5`
- `259.4`
- `259.3`
- `259.2`
- `259.1`
- `259`
- `258.8`
- `258.7`
- `258.6`
- `258.5`
- `258.4`
- `258.3`
- `258.2`
- `258.1`
- `258`
- `257.13`, `257.13.0`
- `257.12`, `257.12.0`
- `257.11`
- `257.10`
- `257.9`
- `257.8`
- `257.7`
- `257.6`
- `257.5`
- `257.4`
- `257.3`
- `257.2`
- `257.1`
- `257`
- `256.17`
- `256.16`
- `256.15`
- `256.14`
- `256.13`
- `256.12`
- `256.11`
- `256.10`
- `256.9`

</details>

**Latest Version**: `261`

### Install Specific Version

```bash
# Install specific version
sh <(curl https://pkgx.sh) +systemd.io@261 -- $SHELL -i
```

## Dependencies

This package depends on:

- `libexpat.github.io`
- `google.com/fullycapable`
- `lz4.org`
- `openssl.org^1.1`
- `github.com/util-linux/util-linux`
- `tukaani.org/xz`
- `facebook.com/zstd`
- `github.com/besser82/libxcrypt`
- `curl.se`
- `gnu.org/libidn2`
- `gnutls.org`
- `sourceware.org/bzip2`
- `pcre.org/v2`

## Usage Examples

```typescript
import { pantry } from 'ts-pkgx'

// Access this package
const pkg = pantry.systemd

console.log(`Package: ${pkg.name}`)
console.log(`Description: ${pkg.description}`)
console.log(`Programs: ${pkg.programs.join(', ')}`)
```

## Links

- [Package Source](https://github.com/pkgxdev/pantry/tree/main/projects/systemd.io/package.yml)
- [Homepage](https://systemd.io)
- [Back to Package Catalog](../../package-catalog.md)

---

> Auto-generated from package data.
