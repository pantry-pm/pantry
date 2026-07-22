await Bun.build({
  entrypoints: ['src/index.ts', 'src/post.ts'],
  outdir: './dist',
  target: 'node',
  format: 'cjs',
  minify: true,
})
