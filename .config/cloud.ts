import type { CloudConfig } from '@ts-cloud/core'

/**
 * Pantry production infrastructure — Hetzner Cloud (no AWS, no CloudFront).
 *
 * Everything runs on a single Hetzner box in `fsn1` that both `registry.pantry.dev`
 * and `pantry.dev`/`www` resolve to (DNS via Porkbun). The box serves the registry
 * API and the static site (`./public`) behind a reverse proxy that terminates TLS
 * (Let's Encrypt). Tarballs/binaries live in Hetzner Object Storage, pointed at by
 * `scripts/configure-registry-storage.sh` (STORAGE_PROVIDER=hetzner) — not in S3.
 *
 * NOTE: the registry box already exists and is (re)deployed by
 * `.github/workflows/deploy-registry.yml` (SSH to `root@registry.pantry.dev`).
 * This config drives the static-site deploy via ts-cloud's Hetzner driver. Before
 * running `cloud deploy`, confirm it ADOPTS the existing box rather than
 * provisioning a new one (set HCLOUD_TOKEN and check the plan first).
 */
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
