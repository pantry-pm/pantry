import type { Recipe } from '../../scripts/recipe-types'

/**
 * WireGuard userspace control-plane tools (`wg`, `wg-quick`).
 *
 * The data plane is the in-kernel WireGuard module (mainline since Linux 5.6),
 * not this package — these are just the small C `wg` utility plus the
 * `wg-quick` shell wrapper used to bring tunnels up/down. That's why the build
 * is a plain `make -C src install` with no crypto/library dependencies: the
 * kernel does the cryptography.
 *
 * Used by the uptime-status multi-region deploy to tunnel a second-region
 * check worker to the primary's Postgres/Redis over a private link
 * (docs/features/second-region-runbook.md).
 */
export const recipe: Recipe = {
  domain: 'wireguard.com',
  name: 'wireguard-tools',
  description: 'Fast, modern, secure VPN tunnel — the `wg` and `wg-quick` userspace configuration utilities for WireGuard (the data plane lives in the kernel).',
  homepage: 'https://www.wireguard.com',
  github: 'https://github.com/WireGuard/wireguard-tools',
  programs: ['wg', 'wg-quick'],
  versionSource: {
    type: 'github-tags',
    repo: 'WireGuard/wireguard-tools',
  },
  distributable: {
    // Upstream ships xz snapshots keyed by the bare version (no `v` prefix),
    // which is exactly what github-tags yields for this repo.
    url: 'https://git.zx2c4.com/wireguard-tools/snapshot/wireguard-tools-{{version}}.tar.xz',
    stripComponents: 1,
  },
  build: {
    script: [
      'make -C src install',
    ],
    env: {
      PREFIX: '${{prefix}}',
      // Install wg-quick and its man page; skip distro-specific bits that don't
      // belong in a relocatable prefix.
      WITH_WGQUICK: 'yes',
      WITH_BASHCOMPLETION: 'no',
      WITH_SYSTEMDUNITS: 'no',
    },
  },
}
