// tsup bundles the registry JSON into the JS output, but we also expose it as a
// standalone export ("hoodchain/registry/stock-tokens.json") for non-JS consumers.
import { mkdir, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
await mkdir(join(root, 'dist/registry'), { recursive: true })
await copyFile(
  join(root, 'src/registry/stock-tokens.json'),
  join(root, 'dist/registry/stock-tokens.json'),
)
console.log('registry JSON copied to dist/registry/')
