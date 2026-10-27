import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PackageCatalogEntry, PackageLogo } from '../src/catalog/types'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const manifestPath = join(root, 'catalog/logos.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, PackageLogo>
const catalog = JSON.parse(readFileSync(join(root, 'catalog/packages.json'), 'utf8')).packages as PackageCatalogEntry[]
const assetDir = join(root, 'assets/package-logos')
mkdirSync(assetDir, { recursive: true })
const official: Record<string, string> = {
  'bun.sh': 'https://bun.sh/logo.svg',
  'git-scm.org': 'https://git-scm.com/images/logos/downloads/Git-Icon-1788C.png',
  'github.com': 'https://github.githubassets.com/favicons/favicon.svg',
  'python.org': 'https://www.python.org/static/favicon.ico',
  'nodejs.org': 'https://nodejs.org/static/images/favicons/favicon.png',
  'ziglang.org': 'https://ziglang.org/favicon.png',
}
const byOrigin = new Map<string, Promise<PackageLogo | null>>()
async function download(url: string, html = false): Promise<{ bytes: Uint8Array, url: string } | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Pantry-Catalog-Artwork/1.0 (+https://github.com/pantry-pm/pantry)' } })
    if (!response.ok || !response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > (html ? 262144 : 524288)) {
          if (!html) return null
          break
        }
        chunks.push(value)
        if (html && Buffer.concat(chunks).includes(Buffer.from('</head>'))) break
      }
    }
    finally { await reader.cancel().catch(() => {}) }
    return { bytes: Buffer.concat(chunks), url: response.url }
  }
  catch { return null }
}
function imageExtension(bytes: Uint8Array): string | null {
  const data = Buffer.from(bytes)
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpg'
  if (data.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'ico'
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'webp'
  const text = data.toString('utf8')
  if (/<svg[\s>]/i.test(text) && !/<(?:script|foreignObject)[\s>]|\bon\w+\s*=|(?:href|src)\s*=\s*['"]\s*(?:https?:|\/\/|javascript:)/i.test(text)) return 'svg'
  return null
}
async function retain(url: string): Promise<PackageLogo | null> {
  const downloaded = await download(url)
  if (!downloaded) return null
  const extension = imageExtension(downloaded.bytes)
  if (!extension) return null
  const sha256 = createHash('sha256').update(downloaded.bytes).digest('hex')
  const file = `${sha256}.${extension}`
  writeFileSync(join(assetDir, file), downloaded.bytes)
  return { url: `https://raw.githubusercontent.com/pantry-pm/pantry/main/assets/package-logos/${file}`, sourceUrl: downloaded.url, sha256 }
}
async function discover(entry: PackageCatalogEntry): Promise<PackageLogo | null> {
  if (official[entry.domain]) {
    const logo = await retain(official[entry.domain]!)
    if (logo) return logo
  }
  const home = entry.homepageUrl || (entry.domain.includes('.') ? `https://${entry.domain.split('/')[0]}` : '')
  if (!home) return null
  let url: URL
  try { url = new URL(home) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  if (url.hostname === 'github.com') {
    const repo = (entry.githubUrl || home).match(/^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/)
    if (!repo) return null
    const readme = await download(`https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/HEAD/README.md`, true)
    if (readme) {
      const markdown = Buffer.from(readme.bytes).toString()
      const candidates = [...markdown.matchAll(/(?:src\s*=\s*["']([^"']+)["']|!\[[^\]]*\]\(([^)\s]+)\))/gi)].map(match => match[1] || match[2]!).filter(value => /logo|icon/i.test(value) && /\.(?:svg|png|webp|ico)(?:[?#]|$)/i.test(value))
      for (const image of candidates.slice(0, 3)) {
        const resolved = new URL(image, `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/HEAD/`).href
        if (resolved.startsWith('https://')) {
          const logo = await retain(resolved)
          if (logo) return logo
        }
      }
    }
    return null
  }
  if (byOrigin.has(url.origin)) return await byOrigin.get(url.origin)!
  const promise = (async () => {
    const page = await download(url.href, true)
    const html = page ? Buffer.from(page.bytes).toString() : ''
    const candidates: string[] = []
    for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = match[0]
      if (!/\brel\s*=\s*["'][^"']*(?:icon|apple-touch-icon)[^"']*["']/i.test(tag)) continue
      const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
      if (href) candidates.push(new URL(href.replaceAll('&amp;', '&'), page?.url ?? url.href).href)
    }
    candidates.sort((a, b) => Number(b.includes('.svg')) - Number(a.includes('.svg')))
    candidates.push(new URL('/favicon.ico', url).href)
    for (const candidate of [...new Set(candidates)].slice(0, 5)) {
      if (!candidate.startsWith('https://')) continue
      const logo = await retain(candidate)
      if (logo) return logo
    }
    return null
  })()
  byOrigin.set(url.origin, promise)
  return await promise
}
let cursor = 0
let completed = 0
function save() { writeFileSync(manifestPath, JSON.stringify(Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n') }
await Promise.all(Array.from({ length: 16 }, async () => {
  while (cursor < catalog.length) {
    const entry = catalog[cursor++]!
    if (!manifest[entry.domain]) {
      const logo = await discover(entry).catch(() => null)
      if (logo) manifest[entry.domain] = logo
    }
    completed++
    if (completed % 50 === 0) {
      save()
      console.log(`${completed}/${catalog.length} checked; ${Object.keys(manifest).length} original logos retained`)
    }
  }
}))
save()
console.log(`Finished: ${Object.keys(manifest).length}/${catalog.length} packages have verified artwork; projects without artwork retain a generic package glyph.`)
