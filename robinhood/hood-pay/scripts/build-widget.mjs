/**
 * Build the self-contained checkout bundle (IIFE, minified) to
 * dist/hood-pay.min.js, copy it into docs/ for the GitHub Pages site, and
 * enforce the size budget: the work order caps the widget at 30 kB gzipped.
 * The build FAILS if the budget is exceeded - no silent bloat.
 */
import { build } from 'esbuild'
import { gzipSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'dist/hood-pay.min.js')
const BUDGET_GZIP_BYTES = 30 * 1024

mkdirSync(resolve(root, 'dist'), { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/widget/iife.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  platform: 'browser',
  outfile,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: '/* hood-pay checkout widget | MIT | https://github.com/nirholas/hood-pay */' },
})

const raw = readFileSync(outfile)
const gzipped = gzipSync(raw, { level: 9 })
const kb = (n) => (n / 1024).toFixed(1)
console.log(`hood-pay.min.js  ${kb(raw.length)} kB raw  ${kb(gzipped.length)} kB gzip  (budget ${kb(BUDGET_GZIP_BYTES)} kB gzip)`)

if (gzipped.length > BUDGET_GZIP_BYTES) {
  console.error(`SIZE BUDGET EXCEEDED by ${kb(gzipped.length - BUDGET_GZIP_BYTES)} kB gzip`)
  process.exit(1)
}

copyFileSync(outfile, resolve(root, 'docs/hood-pay.min.js'))
writeFileSync(resolve(root, 'dist/widget-size.json'), JSON.stringify({ raw: raw.length, gzip: gzipped.length }, null, 2) + '\n')
console.log('copied to docs/hood-pay.min.js')
