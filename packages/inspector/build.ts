#!/usr/bin/env bun
/**
 * Render the inspector to static HTML.
 *
 * The dev server renders a page per request, which is right while you are
 * iterating on a tree that changes under you. A published report is the
 * opposite: one tree, frozen, read by people who will never run the analyzer.
 * So this walks the same pages with the same server scripts and writes the
 * result out, including one page per installed package.
 *
 * Usage: bun build.ts [--project <dir>] [--out <dir>]
 */

import { dirname, join, relative } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const projectRoot = arg('project', process.env.PANTRY_PROJECT_ROOT || process.cwd())
const outDir = arg('out', join(here, 'dist'))

// The server scripts read this, so it has to be set before any page renders.
process.env.PANTRY_PROJECT_ROOT = projectRoot

const { analyzeNodeModules, formatBytes } = await import('./lib/node-modules.ts')
const { extractVariables, processDirectives, defaultConfig } = await import('@stacksjs/stx')

const SERVER_SCRIPT = /<script\s+server\b[^>]*>([\s\S]*?)<\/script>/i

async function render(templatePath: string, params: Record<string, string> = {}): Promise<string> {
  const source = readFileSync(templatePath, 'utf8')
  const script = source.match(SERVER_SCRIPT)
  const template = script ? source.replace(new RegExp(SERVER_SCRIPT.source, 'gi'), '') : source

  const context: Record<string, unknown> = {
    __filename: templatePath,
    __dirname: dirname(templatePath),
    ...params,
  }

  if (script)
    await extractVariables(script[1], context, templatePath)

  // Partials resolve relative to the working directory by default, and this
  // build runs from the project being analysed, not from here. Point it at the
  // inspector's own partials or every page renders with six include errors
  // where its nav and stylesheet should be.
  const config = { ...defaultConfig, partialsDir: join(here, 'partials') }
  return processDirectives(template, context, templatePath, config, new Set<string>())
}

function write(route: string, html: string): void {
  // Directory-per-route, so a static host serves `/modules` without a rewrite.
  const file = route === '/' ? join(outDir, 'index.html') : join(outDir, route, 'index.html')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, html)
}

/** Every non-partial page template, as [route, file] pairs. */
function pages(dir: string, base = ''): Array<{ route: string, file: string }> {
  const found: Array<{ route: string, file: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'partials') continue
      found.push(...pages(join(dir, entry.name), base ? `${base}/${entry.name}` : entry.name))
      continue
    }
    if (!entry.name.endsWith('.stx')) continue
    const name = entry.name.slice(0, -4)
    const route = `${base ? `/${base}` : ''}${name === 'index' ? '' : `/${name}`}`
    found.push({ route: route || '/', file: join(dir, entry.name) })
  }
  return found
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const analysis = analyzeNodeModules(projectRoot)
const packageNames = [...new Set(analysis.packages.map(p => p.name))].sort()

console.warn(`inspector: ${projectRoot}`)
console.warn(`  ${analysis.totalPackages} installs, ${analysis.distinctNames} names, ${formatBytes(analysis.totalBytes)} on disk`)

let written = 0
const failed: string[] = []

for (const page of pages(join(here, 'pages'))) {
  // Dynamic routes are expanded below, one page per package.
  if (page.file.includes('[')) continue
  try {
    write(page.route, await render(page.file))
    written++
  }
  catch (error) {
    failed.push(`${page.route}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const detailTemplate = join(here, 'pages/module/[name].stx')
if (existsSync(detailTemplate)) {
  for (const name of packageNames) {
    try {
      write(`/module/${encodeURIComponent(name)}`, await render(detailTemplate, { name }))
      written++
    }
    catch (error) {
      failed.push(`/module/${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// The analysis itself, so the numbers on the page can be checked against
// something other than the page.
writeFileSync(join(outDir, 'node-modules.json'), JSON.stringify(analysis))

// Every page carries the same stylesheet and the same nav, inline. Across ~190
// pages that is most of the output, and none of it survives a navigation.
// stx's own build does this to its pages; these are rendered here rather than
// by its site builder, so do it explicitly.
const { externalizeSharedAssets, externalizeRepeatedAssets } = await import('@stacksjs/stx')
const shared = externalizeSharedAssets(outDir)
const repeated = externalizeRepeatedAssets(outDir)
const lifted = shared.bytesInlined + repeated.bytesInlined
if (lifted > 0)
  console.warn(`inspector: lifted ${formatBytes(lifted)} of repeated markup into ${shared.assets + repeated.assets} shared asset(s)`)

if (failed.length) {
  console.error(`inspector: ${failed.length} page(s) failed`)
  for (const failure of failed) console.error(`  ${failure}`)
  process.exit(1)
}

console.warn(`inspector: wrote ${written} pages to ${relative(process.cwd(), outDir) || outDir}`)
