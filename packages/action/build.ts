import { resolve } from 'node:path'
import { assertPortableActionBundle, makeCrc64SourcePortable } from './src/build-portability'

const result = await Bun.build({
  entrypoints: ['src/index.ts', 'src/post.ts'],
  outdir: './dist',
  target: 'node',
  format: 'cjs',
  minify: true,
  plugins: [{
    name: 'portable-azure-crc64',
    setup(build) {
      build.onLoad({ filter: /@azure\/storage-common\/dist\/esm\/crc64\.js$/ }, async ({ path }) => ({
        contents: makeCrc64SourcePortable(await Bun.file(path).text()),
        loader: 'js',
      }))
    },
  }],
})

if (!result.success) throw new AggregateError(result.logs, 'GitHub Action build failed')
for (const output of result.outputs) {
  if (output.path.endsWith('.js')) assertPortableActionBundle(await output.text(), resolve(import.meta.dir, '../..'))
}
