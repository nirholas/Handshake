// Copies the freshly-built browser bundle into docs/ so the static docs
// site (GitHub Pages, no bundler) always ships the current library build.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const built = join(root, 'dist', 'docs', 'hood-connect.global.js')
const target = join(root, 'docs', 'hood-connect.iife.js')

if (!existsSync(built)) {
  console.error(`Missing ${built}. Run tsup first (npm run build).`)
  process.exit(1)
}
mkdirSync(dirname(target), { recursive: true })
copyFileSync(built, target)
console.log(`docs bundle -> ${target}`)
