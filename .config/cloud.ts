import type { CloudConfig } from '@ts-cloud/core'
import process from 'node:process'

/**
 * Pantry production infrastructure — Hetzner Cloud (no AWS, no CloudFront).
 *
 * Everything runs on the shared Stacks Hetzner box in `fsn1` that
 * `registry.pantry.dev`, `pantry.dev` and `www.pantry.dev` all resolve to (DNS via
 * Porkbun). Tarballs and binaries live in Hetzner Object Storage, pointed at by
 * `pantry registry storage` (STORAGE_PROVIDER=hetzner) — not in S3.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DO NOT RUN `cloud deploy` AGAINST THIS CONFIG. It is not how pantry ships, and
 * the guard below stops it. Audited 2026-08-11; the reasons are concrete:
 *
 *   1. The registry is NOT a ts-cloud site. `.github/workflows/deploy-registry.yml`
 *      is a 656-line host provisioner: it git-resets /opt/pantry-registry/repo to
 *      the deployed SHA, runs `bun install` + `build:server`, installs and tunes
 *      clamav-daemon (clamd.conf limits, MaxScanTime 45m, capacity drop-ins with
 *      deliberate CPU scheduling), sets up systemd-isolated scanner workers, and
 *      restarts `pantry-registry.service`. ts-cloud has no vocabulary for any of it.
 *
 *   2. ts-cloud's generated unit is a fixed template — After=network.target,
 *      Restart=always, one EnvironmentFile, Environment=PORT. It cannot express
 *      `Requires=clamav-daemon.service` or the resource caps this service runs
 *      under (MemoryMax=768M, MemorySwapMax=512M, TasksMax=128, CPUWeight/IOWeight
 *      80). Deploying through it would silently drop the malware-scanner ordering
 *      and the memory caps that keep the registry from starving the other tenants.
 *
 *   3. `sites` below describes a static site on `pantry.dev` served from `./public`.
 *      That is not what runs: all three hosts proxy to the registry on :3001, and
 *      `./public` holds only `fonts/` and `install.sh` — no index. Deploying it
 *      would replace the routes and drop `registry.pantry.dev` from the rpx
 *      fragment entirely, taking the package registry offline.
 *
 * What ts-cloud DOES own here: nothing at deploy time. The box-side rpx fragment
 * `/etc/rpx/sites.d/pantry.json` and the `rpx-cert-renew-pantry.{service,timer}`
 * units are maintained out of band; the renew timer covers all three hosts and was
 * verified on 2026-08-11.
 *
 * To bring pantry into the tenant flow properly, ts-cloud first needs a proxy-only
 * site kind (a route with an upstream that ts-cloud does not own the unit for).
 * Today `resolveSiteKind` only emits an upstream route for sites with `start`,
 * which forces ts-cloud to manage the systemd unit.
 * ─────────────────────────────────────────────────────────────────────────────
 */
if (!process.env.PANTRY_ALLOW_TS_CLOUD_DEPLOY) {
  throw new Error(
    'pantry does not deploy through ts-cloud. The registry is provisioned by '
    + '.github/workflows/deploy-registry.yml; running `cloud deploy` here would '
    + 'rewrite /etc/rpx/sites.d/pantry.json and drop registry.pantry.dev. '
    + 'See the comment at the top of .config/cloud.ts. Set '
    + 'PANTRY_ALLOW_TS_CLOUD_DEPLOY=1 only if you have read it and mean to.',
  )
}
const config: CloudConfig = {
  project: {
    name: 'pantry',
    slug: 'pantry',
    region: 'fsn1', // Hetzner location (Falkenstein) — not an AWS region
  },

  // Deploy to Hetzner, not AWS. (resolveCloudProvider also auto-detects Hetzner
  // when hetzner.apiToken is set, but be explicit.)
  cloud: { provider: 'hetzner' },

  hetzner: {
    // Falls back to HCLOUD_TOKEN / HETZNER_API_TOKEN if unset.
    apiToken: process.env.HCLOUD_TOKEN,
    location: 'fsn1',
    image: 'ubuntu-24.04',
    sshPrivateKeyPath: '~/.ssh/stacks-production.pem',
    sshUser: 'root',
  },

  environments: {
    production: {
      type: 'production',
      domain: 'pantry.dev',
      variables: {
        NODE_ENV: 'production',
      },
    },
  },

  infrastructure: {
    dns: {
      domain: 'pantry.dev',
      provider: 'porkbun',
    },

    compute: {
      size: 'small', // Hetzner cx23 (2 vCPU, 4 GB)
      runtime: 'bun',

      monitoring: {
        alerts: {
          // The bucket's included traffic. This is host NIC bandwidth, which is
          // a different (and much smaller) number than object-storage egress —
          // see egressEndpoints below for the one that actually gets billed.
          bandwidthTb: 5,
        },
        // Artifact downloads are a redirect to the bucket, so their bytes never
        // touch this host's network interface. The registry counts them at the
        // moment it authorizes the redirect and reports them here; without this
        // the dashboard would show an idle box while the bucket served
        // terabytes, which is exactly how the last overrun went unnoticed.
        egressEndpoints: [
          { name: 'registry', url: 'https://registry.pantry.dev/api/egress' },
        ],
      },
    },
  },

  sites: {
    main: {
      root: './public',
      domain: 'pantry.dev',
      deploy: 'server', // serve straight from the Hetzner box (no S3 + CloudFront)
      installScript: './public/install.sh',
    },
  },

  tags: {
    project: 'pantry',
    environment: 'production',
    managedBy: 'ts-cloud',
  },
}

export default config
