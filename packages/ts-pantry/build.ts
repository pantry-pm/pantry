import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import { dts } from 'bun-plugin-dtsx'

/**
 * Everything the last build left behind.
 *
 * With code splitting on, chunk filenames are content-hashed, so a change to
 * any module produces a new chunk name and orphans the old file. Nothing
 * removed it, and `files` publishes `dist` wholesale, so every release carried
 * the accumulated chunks of every build before it.
 *
 * That is not merely wasted bytes. ts-pantry 0.11.20 shipped
 * `chunk-akzqpam7.js`, 161 bytes re-exporting nineteen identifiers the file
 * neither declares nor imports — half of a split pair whose other half is long
 * gone. Importing the package threw `"s" is not declared in this file` from a
 * path inside node_modules, in consumers with no way to act on it.
 */
function cleanDist() {
  const dist = path.join(process.cwd(), 'dist')
  if (fs.existsSync(dist))
    fs.rmSync(dist, { recursive: true, force: true })
}

/**
 * A chunk that re-exports names it does not have.
 *
 * The failure mode above is silent at build time — Bun reports success, the
 * file is valid syntax, and the reference only resolves (or doesn't) when
 * something imports it. Cheap enough to check every emitted file.
 */
function findBrokenChunks(): string[] {
  const dist = path.join(process.cwd(), 'dist')
  const broken: string[] = []

  for (const entry of fs.readdirSync(dist)) {
    if (!entry.endsWith('.js'))
      continue

    const source = fs.readFileSync(path.join(dist, entry), 'utf-8')
    const exported = source.match(/export\s*\{([^}]*)\}/)?.[1]

    // A re-export list is only meaningful if something in the file supplies
    // the names. A file that is nothing but the list cannot.
    if (exported && !/\b(?:var|let|const|function|class|import)\b/.test(source))
      broken.push(entry)
  }

  return broken
}

async function build() {
  console.log('Building...')
  cleanDist()

  const result = await Bun.build({
    entrypoints: ['src/index.ts', 'bin/cli.ts', 'src/testing/index.ts'],
    outdir: './dist',
    target: 'node',
    splitting: false,
    minify: true,
    plugins: [dts()],
  })

  if (!result.success) {
    console.error('Build failed:', result.logs)
    process.exit(1)
  }

  // Manually copy generated-package-names.ts as .d.ts to preserve formatting
  // This file has special formatting requirements that bun-plugin-dtsx mangles
  const generatedSrc = path.join(process.cwd(), 'src', 'generated-package-names.ts')
  const generatedDest = path.join(process.cwd(), 'dist', 'generated-package-names.d.ts')
  if (fs.existsSync(generatedSrc)) {
    const content = fs.readFileSync(generatedSrc, 'utf-8')
    // Convert .ts to .d.ts by removing any non-type exports
    const dtsContent = content.replace(/^(export\s+)(?!type\s|interface\s)/gm, '$1declare ')
    fs.writeFileSync(generatedDest, dtsContent, 'utf-8')
    console.log('Copied generated-package-names.ts -> generated-package-names.d.ts')
  }

  const broken = findBrokenChunks()

  if (broken.length) {
    console.error(`Build produced ${broken.length} chunk(s) that re-export undeclared names:`)
    for (const entry of broken)
      console.error(`  dist/${entry}`)
    process.exit(1)
  }

  console.log('Build completed successfully!')
}

build().catch((error) => {
  console.error('Build error:', error)
  process.exit(1)
})
