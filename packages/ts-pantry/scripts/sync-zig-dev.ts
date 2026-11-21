import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ziglangOfficialDownload } from '../src/installer'
import { publishBinaryArtifact } from './binary-publish-client'
import { verifyGlibcFloor } from './glibc-floor'

// Zig Software Foundation release signing key from https://ziglang.org/download/.
const publicKey = 'RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U'
const domain = 'ziglang.org'
const registryUrl = 'https://registry.pantry.dev'
const platforms = [
  { os: 'darwin', arch: 'aarch64', key: 'darwin-arm64' },
  { os: 'darwin', arch: 'x86_64', key: 'darwin-x86-64' },
  { os: 'linux', arch: 'aarch64', key: 'linux-arm64' },
  { os: 'linux', arch: 'x86_64', key: 'linux-x86-64' },
  { os: 'windows', arch: 'aarch64', key: 'windows-arm64' },
  { os: 'windows', arch: 'x86_64', key: 'windows-x86-64' },
] as const

async function request(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok)
    throw new Error(`HTTP ${response.status} requesting ${url}`)
  return response
}

function download(url: string, destination: string): void {
  execFileSync('curl', [
    '--fail', '--silent', '--show-error', '--location', '--proto', '=https',
    '--proto-redir', '=https', '--connect-timeout', '10', '--max-time', '180',
    '--output', destination, url,
  ])
}

function downloadSignedArchive(urls: string[], filename: string, directory: string): string {
  const archive = join(directory, filename)
  const signature = `${archive}.minisig`
  for (const url of urls) {
    try {
      download(`${url}.minisig`, signature)
      download(url, archive)
    }
    catch {
      continue
    }

    // Check the signed filename as well as the data, so another valid Zig
    // version or platform cannot be substituted for the requested compiler.
    const verified = execFileSync('minisign', ['-Vm', archive, '-x', signature, '-P', publicKey], { encoding: 'utf8' })
    const comment = verified.split(/\r?\n/).find(line => line.startsWith('Trusted comment: '))
    if (!comment?.split('\t').includes(`file:${filename}`))
      throw new Error(`The verified Zig signature does not identify ${filename}`)
    console.log(`Verified ${filename} from ${new URL(url).hostname}`)
    return archive
  }
  throw new Error(`No upstream mirror has both ${filename} and its signature`)
}

async function publishPlatform(version: string, platform: typeof platforms[number], mirrors: string[]): Promise<void> {
  const { url, format, prefix } = ziglangOfficialDownload(version, platform)
  const filename = `${prefix}.${format}`
  const directory = mkdtempSync(join(tmpdir(), 'pantry-zig-dev-'))
  try {
    const archive = downloadSignedArchive([url, ...mirrors.map(mirror => `${mirror}/${filename}`)], filename, directory)
    execFileSync('bsdtar', ['-xf', archive, '-C', directory])
    const extracted = join(directory, prefix)
    const packageRoot = join(directory, 'package')
    const bin = join(packageRoot, 'bin')
    const executable = platform.os === 'windows' ? 'zig.exe' : 'zig'
    mkdirSync(bin, { recursive: true })
    renameSync(join(extracted, executable), join(bin, executable))
    renameSync(join(extracted, 'lib'), join(packageRoot, 'lib'))
    renameSync(join(extracted, 'LICENSE'), join(packageRoot, 'LICENSE'))

    const tarball = `${domain}-${version}.tar.gz`
    const filePath = join(directory, tarball)
    execFileSync('tar', ['-czf', filePath, '-C', packageRoot, 'bin', 'lib', 'LICENSE'])
    if (platform.os === 'linux')
      await verifyGlibcFloor(filePath)
    const result = await publishBinaryArtifact({
      domain,
      version,
      platforms: [platform.key],
      filePath,
      filename: tarball,
      size: statSync(filePath).size,
      registryUrl,
    })
    console.log(`Published ${domain}@${version} for ${platform.key} (${result.scan.artifactSha256})`)
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const requested = process.argv[2]?.trim().replace('_', '+')
  const version = requested || (await (await request('https://ziglang.org/download/index.json')).json() as { master: { version: string } }).master.version
  if (!/^\d+\.\d+\.\d+-dev\.\d+\+[0-9a-f]{7,40}$/.test(version))
    throw new Error(`Invalid Zig development version: ${version}`)

  const metadata = await (await request(`${registryUrl}/binaries/${domain}/metadata.json`)).json() as {
    versions: Record<string, { platforms: Record<string, unknown> }>
  }
  const missing = platforms.filter(platform => ![version, version.replace('+', '_')].some(spelling =>
    Object.hasOwn(metadata.versions[spelling]?.platforms ?? {}, platform.key),
  ))
  if (!missing.length) {
    console.log(`${domain}@${version} is already archived on all supported platforms`)
    return
  }

  const mirrors = (await (await request('https://ziglang.org/download/community-mirrors.txt')).text())
    .split(/\s+/).filter(mirror => mirror.startsWith('https://')).map(mirror => mirror.replace(/\/+$/, ''))
  const failures = await Promise.allSettled(missing.map(platform => publishPlatform(version, platform, mirrors)))
  const errors = failures.flatMap((result, index) => result.status === 'rejected'
    ? [new Error(`${missing[index]!.key}: ${result.reason}`)]
    : [])
  if (errors.length)
    throw new AggregateError(errors, `Failed to archive ${domain}@${version}`)
}

await main()
