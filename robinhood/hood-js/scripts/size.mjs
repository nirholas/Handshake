#!/usr/bin/env node
// Reports hood-js's own gzipped bundle size and checks it against the budget.
// viem (peer) and hoodchain (dependency) are external and NOT counted here —
// they are installed alongside, exactly like viem is for any viem-based lib.
import { readFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUDGET_KB = 15

function report(label, file) {
  const bytes = statSync(file).size
  const gz = gzipSync(readFileSync(file)).length
  console.log(
    `${label.padEnd(22)} ${(bytes / 1024).toFixed(2).padStart(8)} kB   ${(gz / 1024)
      .toFixed(2)
      .padStart(8)} kB gz`,
  )
  return gz
}

console.log('hood-js bundle size (external: viem, hoodchain)\n')
console.log(`${''.padEnd(22)} ${'raw'.padStart(8)}        ${'gzipped'.padStart(8)}`)
const esm = report('dist/index.js (ESM)', join(root, 'dist/index.js'))
report('dist/index.cjs (CJS)', join(root, 'dist/index.cjs'))

const gzKb = esm / 1024
console.log(`\nBudget: ≤ ${BUDGET_KB} kB gzipped on top of viem`)
if (gzKb <= BUDGET_KB) {
  console.log(`PASS — ${gzKb.toFixed(2)} kB (${(BUDGET_KB - gzKb).toFixed(2)} kB headroom)`)
} else {
  console.error(`FAIL — ${gzKb.toFixed(2)} kB exceeds the ${BUDGET_KB} kB budget`)
  process.exit(1)
}
