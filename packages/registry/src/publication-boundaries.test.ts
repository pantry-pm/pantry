import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8')
}

describe('first-party publication boundaries', () => {
  it('keeps native publishers behind the scan-before-promote API', () => {
    const centralUploader = source('packages/ts-pantry/scripts/upload-to-s3.ts')
    const client = source('packages/ts-pantry/scripts/binary-publish-client.ts')
    const zigPublisher = source('packages/zig/src/cli/commands/publish_binary.zig')
    const phpBundler = source('packages/ts-pantry/scripts/bundle-php.sh')
    const pkgxFallback = source('packages/registry/src/pkgx-fallback.ts')

    expect(centralUploader).not.toContain('createObjectStorageClient')
    expect(centralUploader).not.toContain('.putObject(')
    expect(centralUploader).toContain('publishBinaryArtifact')
    expect(client).toContain('/api/v1/binaries/uploads')
    expect(client).toContain('/api/v1/binaries/uploads/complete')
    expect(zigPublisher).not.toContain('aws s3')
    expect(zigPublisher).toContain('/api/v1/binaries/uploads')
    expect(phpBundler).not.toContain('aws s3 cp')
    expect(phpBundler).toContain('scripts/upload-to-s3.ts')
    expect(pkgxFallback).not.toContain('s3.putObject')
    expect(pkgxFallback).not.toContain('await res.arrayBuffer()')
    expect(pkgxFallback).not.toContain('readFileSync(gzPath)')
    expect(pkgxFallback).toContain('publisher.initiate')
    expect(pkgxFallback).toContain('publisher.complete')
  })

  it('keeps the legacy core publisher behind the authenticated API', () => {
    const legacyPublisher = source('packages/registry/app/publish.ts')
    expect(legacyPublisher).not.toContain('S3Client')
    expect(legacyPublisher).not.toContain('DynamoDBClient')
    expect(legacyPublisher).toContain('fetch(`${registryUrl}/publish`')
  })

  it('enforces staging cleanup and registry-only installable writes in CloudFormation', () => {
    const template = source('packages/registry/infrastructure/cloudformation.yml')
    expect(template).toContain('ExpireAbandonedMalwareStaging')
    expect(template).toContain('ExpireAbandonedSealedArtifacts')
    expect(template).toContain('DenyNonRegistryInstallableWrites')
    expect(template).toContain('${PackagesBucket.Arn}/binaries/*')
    expect(template).toContain('aws:PrincipalArn: !GetAtt RegistryRole.Arn')
  })

  it('deploys the exact bundle only after scanner readiness is proven', () => {
    const workflow = source('.github/workflows/deploy-registry.yml')
    expect(workflow).toContain("EXPECTED_SHA=\"$5\"")
    expect(workflow).toContain('NODE_ENV=production "$BUN" run build:server')
    expect(workflow).toContain('set_env PANTRY_MALWARE_SCANNING required')
    expect(workflow).toContain('set_env CLAMD_SOCKET /run/clamav/clamd.ctl')
    expect(workflow).toContain("vars.PANTRY_REQUIRE_BINARY_SCAN_ATTESTATION || 'false'")
    expect(workflow).toContain('set_clam MaxThreads 2')
    expect(workflow).toContain('set_clam MaxQueue 4')
    expect(workflow).toContain('set_clam ConcurrentDatabaseReload no')
    expect(workflow).toContain('systemctl restart clamav-daemon')
    expect(workflow).toContain("ExecCondition=/bin/sh -c '! systemctl is-active --quiet apt-daily-upgrade.service'")
    expect(workflow).not.toContain('is-active --quiet unattended-upgrades.service')
    expect(workflow).toContain('${SERVICE}-recovery.timer')
    expect(workflow).toContain('${REGISTRY_URL}/ready')
    expect(workflow).toContain('.malwareScanning.required == true')
    expect(workflow).toContain('.malwareScanning.ready == true')
    expect(workflow).toContain('.code == "MALWARE_DETECTED"')
    expect(workflow).toContain('.scan.verdict == "blocked"')
  })

  it('serializes retained-artifact backfill scans to production scanner capacity', () => {
    const workflow = source('.github/workflows/backfill-malware-scans.yml')
    expect(workflow).toContain('max-parallel: 1')
  })

  it('keeps CLI provisioning within the registry host resource budget', () => {
    const setup = source('packages/zig/src/cli/commands/registry_ops.zig')
    expect(setup).toContain('set_clam MaxThreads 2')
    expect(setup).toContain('set_clam MaxQueue 4')
    expect(setup).toContain('set_clam ConcurrentDatabaseReload no')
  })
})
