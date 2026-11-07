import type { CustomVersionSource } from './recipe-types'

/** Official vendor metadata only. A missing feed is an error, never a pinned fallback. */
export async function vendorResponse(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response
}

export function textVersionSource(url: string, pattern: RegExp): CustomVersionSource {
  return { type: 'custom', fetch: async () => {
    const text = await (await vendorResponse(url)).text()
    const versions = [...text.matchAll(new RegExp(pattern.source, [...new Set(`${pattern.flags}g`)].join('')))].map(match => match[1]).filter(Boolean)
    if (!versions.length) throw new Error(`No desktop versions in ${url}`)
    return [...new Set(versions)]
  } }
}

export function jsonVersionSource(url: string, select: (data: any) => string[]): CustomVersionSource {
  return { type: 'custom', fetch: async () => {
    const versions = select(await (await vendorResponse(url)).json()).filter(value => typeof value === 'string' && value.length > 0)
    if (!versions.length) throw new Error(`No desktop versions in ${url}`)
    return [...new Set(versions)]
  } }
}

export function redirectVersionSource(url: string, pattern: RegExp): CustomVersionSource {
  return { type: 'custom', fetch: async () => {
    const response = await vendorResponse(url, { redirect: 'follow' })
    await response.body?.cancel()
    const match = response.url.match(pattern)
    if (!match?.[1]) throw new Error(`No desktop version in redirect ${response.url}`)
    return [match[1]]
  } }
}

export function appcastVersionSource(url: string): CustomVersionSource {
  return { type: 'custom', fetch: async () => {
    const xml = await (await vendorResponse(url)).text()
    const versions = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(([item]) => {
      return item.match(/sparkle:shortVersionString(?:="|>)([^"<]+)(?:"|<)/)?.[1]
        ?? item.match(/sparkle:version="([^"<]+)"/)?.[1]
    }).filter((value): value is string => Boolean(value))
    if (!versions.length) throw new Error(`No desktop versions in ${url}`)
    return [...new Set(versions)]
  } }
}
