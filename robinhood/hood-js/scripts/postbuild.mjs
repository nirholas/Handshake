#!/usr/bin/env node
// Make `require('hood-js')` return the `hood` facade directly (with HoodError
// and default hung off it), the axios-style CJS ergonomic. tsup/esbuild emit
// `exports.default = hood; exports.HoodError = …`, so a plain require would
// otherwise yield `{ default, HoodError }` with no top-level methods. We append
// the reassignment AFTER those export bindings, where ordering is guaranteed.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const cjsPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.cjs')
const marker = '/* hood-js:cjs-facade */'
let code = readFileSync(cjsPath, 'utf8')

if (!code.includes(marker)) {
  code +=
    `\n${marker}\n` +
    'if (module.exports && module.exports.default) {\n' +
    '  Object.assign(module.exports.default, module.exports);\n' +
    '  module.exports = module.exports.default;\n' +
    '}\n'
  writeFileSync(cjsPath, code)
  console.log('postbuild: CJS facade export applied')
} else {
  console.log('postbuild: CJS facade export already present')
}
